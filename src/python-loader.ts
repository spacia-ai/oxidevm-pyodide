import { loadPyodide } from "pyodide";
import type { PyodideInterface } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import { PRECOMPILED_HEADER, VIRTUAL_INDEX, withScopedFetch } from "./artifact-fetch.ts";
import type { FetchScope, ServedFiles } from "./artifact-fetch.ts";
import { ModuleError } from "./errors.ts";
import { decodeLockfile, importMap, wheelsFor } from "./lock.ts";
import type { Lockfile } from "./lock.ts";
import { isWheelFile } from "./shipped.ts";
import { useAtomicSignalPoll } from "./signals.ts";
import type { ShippedFile, WheelFile } from "./shipped.ts";

export type PyodideOptions = NonNullable<Parameters<typeof loadPyodide>[0]>;

/** What the loader asks of a started Pyodide: to load packages by name. The real one satisfies it; tests stand in for it. */
export interface PackageLoader {
  loadPackage(names: string[], options: { messageCallback: (message: string) => void; errorCallback: (message: string) => void }): Promise<unknown>;
}

/**
 * Where Pyodide instantiates its WebAssembly: `instantiateStreaming` is the global one, which the loader replaces while
 * Pyodide starts (`withPrecompiledWasm`), and `instantiate` instantiates a compiled module.
 */
export interface WasmScope {
  instantiateStreaming: (source: Response | PromiseLike<Response>, imports?: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
  readonly instantiate: (module: WebAssembly.Module, imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
}

/** The parts of the Pyodide package the loader drives, so that tests can stand in for them. */
export interface Engine<P extends PackageLoader = PyodideInterface> {
  readonly loadPyodide: (options: PyodideOptions) => Promise<P>;
  readonly createPyodideModule: NonNullable<PyodideOptions["createPyodideModule"]>;
  /** Where Pyodide finds `fetch`: the worker's global scope. */
  readonly scope: FetchScope;
  /** Where Pyodide instantiates its WebAssembly: the worker's `WebAssembly`. */
  readonly wasm: WasmScope;
}

/** The real Pyodide, bundled into the adapter. */
export const bundledEngine: Engine = {
  loadPyodide, createPyodideModule, scope: globalThis,
  wasm: {
    get instantiateStreaming() { return WebAssembly.instantiateStreaming; },
    set instantiateStreaming(replacement) { WebAssembly.instantiateStreaming = replacement; },
    instantiate: (module, imports) => WebAssembly.instantiate(module, imports),
  },
};

/** Emscripten's `instantiateWasm` hook: it receives the interpreter's imports and instantiates it with them. */
export type InstantiateHook = (imports: Record<string, unknown>, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => void;

/** What `withPreparedImports` needs of the settings Pyodide gives its Emscripten factory. */
export interface FactorySettings {
  readonly instantiateWasm?: InstantiateHook | undefined;
}

/**
 * Wraps Pyodide's Emscripten factory so that `prepare` changes the interpreter's imports just before it is instantiated:
 * the factory's `instantiateWasm` hook, which Pyodide always sets, is wrapped, and `prepare` gets the imports and the
 * module (the settings object, which Emscripten makes the `Module`). A factory given no hook fails, since nothing could be
 * prepared; so does a `prepare` that throws.
 */
export function withPreparedImports<S extends FactorySettings, M>(factory: (settings: S) => Promise<M>, prepare: (imports: Record<string, unknown>, module: S) => void): (settings: S) => Promise<M> {
  return settings => {
    const instantiate = settings.instantiateWasm;
    if (instantiate === undefined) return Promise.reject(new ModuleError("interpreter-imports", "Pyodide gave no instantiateWasm hook, so the interpreter's imports cannot be prepared"));
    const hook: InstantiateHook = (imports, done) => {
      prepare(imports, settings);
      instantiate(imports, done);
    };
    Reflect.set(settings, "instantiateWasm", hook);
    return factory(settings);
  };
}

export interface LoadRequest {
  /** The packages to load before the program starts, with everything they depend on; any other loads when imported. */
  readonly packages: readonly string[];
  /** Reads a release artifact, verified against its pin (`host.artifacts.bytes`). */
  readonly bytes: (name: ShippedFile) => Promise<Uint8Array<ArrayBuffer>>;
  /** The interpreter, compiled once for the VM from its verified copy (`host.artifacts.compile`). */
  readonly compile: (name: "pyodide.asm.wasm") => Promise<WebAssembly.Module>;
  /** The process environment Python starts with. */
  readonly env: Readonly<Record<string, string>>;
  /** Receives anything Pyodide reports as an error while it loads. */
  readonly log: (line: string) => void;
}

/** A started Pyodide, with what loads packages into it later. */
export interface LoadedPython<P extends PackageLoader> {
  readonly py: P;
  /** The shipped packages by the top-level modules they provide (`PIL` is pillow), for the import hook. */
  readonly imports: ReadonlyMap<string, string>;
  /** The packages loaded so far, by name. */
  readonly loaded: ReadonlySet<string>;
  /**
   * Loads the packages and what they depend on from the release's verified copies, and resolves with every package
   * that is now loaded. A package the release does not carry is refused before anything is read.
   */
  install(names: readonly string[]): Promise<readonly string[]>;
}

/** The wheels of `names` and of everything they need, refusing a package whose wheel the release does not carry. */
function shippedWheels(lock: Lockfile, names: readonly string[]): readonly { readonly name: string; readonly fileName: WheelFile }[] {
  return wheelsFor(lock, names).map(wheel => {
    if (!isWheelFile(wheel.fileName)) throw new ModuleError("package-not-shipped", `The release carries no wheel for ${wheel.name}`);
    return { name: wheel.name, fileName: wheel.fileName };
  });
}

/**
 * Runs `work` with the scope's `instantiateStreaming` replaced: a response that `PRECOMPILED_HEADER` marks is
 * instantiated from `module`, the interpreter the VM compiled once, instead of being compiled again; anything else goes
 * to the original. The original is put back afterwards, unless something else replaced it meanwhile.
 */
export async function withPrecompiledWasm<T>(wasm: WasmScope, module: WebAssembly.Module, work: () => Promise<T>): Promise<T> {
  const original = wasm.instantiateStreaming;
  const replacement: WasmScope["instantiateStreaming"] = async (source, imports) => {
    const response = await source;
    if (response.headers.get(PRECOMPILED_HEADER) === null) return original(response, imports);
    return { module, instance: await wasm.instantiate(module, imports) };
  };
  wasm.instantiateStreaming = replacement;
  try {
    return await work();
  } finally {
    if (wasm.instantiateStreaming === replacement) wasm.instantiateStreaming = original;
  }
}

/**
 * Starts Pyodide from the release's own files, as the runner verified them once for the VM. The interpreter is the
 * module the VM compiled (`compile`): Pyodide is pointed at a virtual address, a scoped `fetch` answers for that address,
 * and the interpreter's file is answered with an empty response that `withPrecompiledWasm` instantiates from the compiled
 * module, so no start compiles it again. The standard library and the wheels are read from the verified copies only when
 * Pyodide asks for them: the packages of `packages` before the program starts, any other shipped package when the
 * program imports it (`install`). The factory comes from the bundle, so Pyodide never imports code at run time.
 */
export async function loadPython<P extends PackageLoader>(request: LoadRequest, engine: Engine<P>): Promise<LoadedPython<P>> {
  const lockBytes = await request.bytes("pyodide-lock.json");
  const lockText = new TextDecoder().decode(lockBytes);
  const lock = decodeLockfile(lockText);
  const preload = shippedWheels(lock, request.packages);
  const [compiled, stdlib] = await Promise.all([request.compile("pyodide.asm.wasm"), request.bytes("python_stdlib.zip")]);
  const loaded = new Set<string>();
  const runtime = new Map<string, Uint8Array<ArrayBuffer>>([["pyodide-lock.json", lockBytes], ["python_stdlib.zip", stdlib]]);
  const served = (wheels: ReadonlySet<string>): ServedFiles => ({
    index: VIRTUAL_INDEX,
    precompiled: new Set(["pyodide.asm.wasm"]),
    read: name => {
      const known = runtime.get(name);
      if (known !== undefined) return Promise.resolve(known);
      return isWheelFile(name) && wheels.has(name) ? request.bytes(name) : undefined;
    },
  });
  const loadPackages = async (py: P, names: readonly string[], wheels: readonly { readonly name: string; readonly fileName: WheelFile }[]): Promise<void> => {
    if (names.length === 0) return;
    await withScopedFetch(engine.scope, served(new Set(wheels.map(wheel => wheel.fileName))), () => py.loadPackage([...names], { messageCallback: () => undefined, errorCallback: line => { request.log(line); } }));
    for (const wheel of wheels) loaded.add(wheel.name);
  };

  const py = await withScopedFetch(engine.scope, served(new Set()), () => withPrecompiledWasm(engine.wasm, compiled, () => engine.loadPyodide({
    indexURL: VIRTUAL_INDEX,
    packageBaseUrl: VIRTUAL_INDEX,
    lockFileContents: lockText,
    createPyodideModule: withPreparedImports(engine.createPyodideModule, (imports, module) => {
      useAtomicSignalPoll(imports, module);
    }),
    env: { ...request.env },
    stdout: () => undefined,
    stderr: line => { request.log(line); },
  })));
  await loadPackages(py, request.packages, preload);
  return {
    py, loaded, imports: importMap(lock, isWheelFile),
    install: async names => {
      await loadPackages(py, names, shippedWheels(lock, names));
      return [...loaded].sort();
    },
  };
}
