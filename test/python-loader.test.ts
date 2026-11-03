import { describe, expect, it } from "vitest";
import { VIRTUAL_INDEX } from "../src/artifact-fetch.ts";
import type { Fetch } from "../src/artifact-fetch.ts";
import { ModuleError } from "../src/errors.ts";
import { loadPython, withPreparedImports } from "../src/python-loader.ts";
import type { Engine, FactorySettings, LoadRequest, PackageLoader, PyodideOptions, WasmScope } from "../src/python-loader.ts";
import { WHEELS } from "../src/shipped.ts";
import type { ShippedFile } from "../src/shipped.ts";

const LOCK = JSON.stringify({
  packages: {
    pandas: { file_name: WHEELS.pandas, depends: ["numpy", "python-dateutil"] },
    numpy: { file_name: WHEELS.numpy, depends: [] },
    "python-dateutil": { file_name: WHEELS["python-dateutil"], depends: ["six"] },
    six: { file_name: WHEELS.six, depends: [] },
    pytz: { file_name: WHEELS.pytz },
    scipy: { file_name: "scipy-1.16.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", depends: ["numpy"] },
    ghost: { file_name: "ghost-1.0-py3-none-any.whl", depends: [] },
  },
});

interface Fixture {
  readonly request: LoadRequest;
  readonly engine: Engine<PackageLoader>;
  readonly asked: ShippedFile[];
  readonly compiled: string[];
  readonly events: string[];
  readonly options: PyodideOptions[];
  readonly loaded: string[][];
  readonly logs: string[];
  readonly scope: { fetch: Fetch };
  readonly wasm: WasmScope;
  readonly network: string[];
  /** What the fake Pyodide fetched for each `loadPackage`, with the outcome. */
  readonly fetchedByLoad: string[][];
  /** Every wheel unpacked while the program runs, as "<extractDir>: <its bytes>". */
  readonly unpacked: string[];
}

/** A compiled WebAssembly module: the smallest valid one, standing in for the interpreter the VM compiled. */
const COMPILED = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));

interface Overrides {
  readonly bytes?: LoadRequest["bytes"];
  readonly lock?: string;
  readonly during?: (scope: { fetch: Fetch }, wasm: WasmScope) => Promise<void>;
  readonly failLoad?: Error;
  readonly failPackages?: Error;
  /** The wheels the fake Pyodide fetches when asked to load packages. */
  readonly fetchOnLoad?: readonly string[];
  /** What the fake Pyodide reports as its site-packages directory (default /lib/python3.14/site-packages). */
  readonly sitePackages?: unknown;
}

function fixture(packages: readonly string[], overrides: Overrides = {}): Fixture {
  const asked: ShippedFile[] = [], compiled: string[] = [], events: string[] = [], options: PyodideOptions[] = [], loaded: string[][] = [], logs: string[] = [], network: string[] = [], fetchedByLoad: string[][] = [], unpacked: string[] = [];
  const scope: { fetch: Fetch } = { fetch: (input) => { network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); return Promise.resolve(new Response("network")); } };
  const wasm: WasmScope = {
    instantiateStreaming: () => Promise.reject(new Error("the original instantiateStreaming")),
    instantiate: module => { events.push(module === COMPILED ? "instantiate the compiled interpreter" : "instantiate another module"); return Promise.resolve(new WebAssembly.Instance(COMPILED)); },
  };
  const request: LoadRequest = {
    packages, env: { HOME: "/workspace", FOO: "bar" }, log: line => { logs.push(line); }, networkImports: () => { events.push("networkImports"); },
    compile: name => { compiled.push(name); events.push(`compile ${name}`); return Promise.resolve(COMPILED); },
    bytesSync: name => { asked.push(name); events.push(`bytesSync ${name}`); return new TextEncoder().encode(`content of ${name}`); },
    bytes: overrides.bytes ?? ((name: ShippedFile) => { asked.push(name); events.push(`bytes ${name}`); return Promise.resolve(name === "pyodide-lock.json" ? new TextEncoder().encode(overrides.lock ?? LOCK) : new TextEncoder().encode(`content of ${name}`)); }),
  };
  const engine: Engine<PackageLoader> = {
    scope, wasm,
    createPyodideModule: () => Promise.reject(new Error("the factory is only handed over, never called, by the loader")),
    async loadPyodide(given: PyodideOptions) {
      events.push("loadPyodide");
      options.push(given);
      await overrides.during?.(scope, wasm);
      if (overrides.failLoad !== undefined) throw overrides.failLoad;
      return {
        loadPackage: async (names: string[]) => {
          events.push("loadPackage");
          loaded.push(names);
          const fetched: string[] = [];
          for (const wheel of overrides.fetchOnLoad ?? []) fetched.push(`${wheel}: ${await scope.fetch(`${VIRTUAL_INDEX}${wheel}`).then(response => response.text(), () => "refused")}`);
          fetchedByLoad.push(fetched);
          if (overrides.failPackages !== undefined) throw overrides.failPackages;
          return [];
        },
        unpackArchive: (buffer: Uint8Array, format: string, unpackOptions: { extractDir: string }) => { unpacked.push(`${format} ${unpackOptions.extractDir}: ${new TextDecoder().decode(buffer)}`); },
        runPython: (code: string) => { events.push(`runPython ${code.split("\n")[1] ?? ""}`); return overrides.sitePackages === undefined ? "/lib/python3.14/site-packages" : overrides.sitePackages; },
      };
    },
  };
  return { request, engine, asked, compiled, events, options, loaded, logs, scope, wasm, network, fetchedByLoad, unpacked };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("loadPython", () => {
  it("reads only the lock and the standard library before Pyodide starts, and takes the interpreter the VM compiled", async () => {
    const f = fixture([]);
    await loadPython(f.request, f.engine);
    expect([...f.asked].sort()).toEqual(["pyodide-lock.json", "python_stdlib.zip"]);
    expect(f.compiled).toEqual(["pyodide.asm.wasm"]);
    expect(f.loaded).toEqual([]);
  });

  it("reads the wheels of the packages to preload, and what they need, only when Pyodide fetches them", async () => {
    const f = fixture(["pandas"], { fetchOnLoad: [WHEELS.pandas, WHEELS.six, WHEELS.pytz] });
    const loaded = await loadPython(f.request, f.engine);
    expect(f.loaded).toEqual([["pandas"]]);
    // pytz is not something pandas needs in this lock, so it is not served.
    expect(f.fetchedByLoad).toEqual([[`${WHEELS.pandas}: content of ${WHEELS.pandas}`, `${WHEELS.six}: content of ${WHEELS.six}`, `${WHEELS.pytz}: refused`]]);
    expect([...f.asked].sort()).toEqual(["pyodide-lock.json", "python_stdlib.zip", WHEELS.pandas, WHEELS.six].sort());
    expect([...loaded.loaded].sort()).toEqual(["numpy", "pandas", "python-dateutil", "six"]);
  });

  it("checks the packages to preload against the lock and the release before Pyodide starts", async () => {
    const f = fixture(["nonexistent"]);
    const error = await failure(loadPython(f.request, f.engine));
    expect(error instanceof ModuleError ? [error.code, error.message] : []).toEqual(["package-unknown", "The Pyodide lock has no package nonexistent"]);
    expect(f.options).toEqual([]);
    for (const requested of ["scipy", "ghost"]) {
      const g = fixture([requested]);
      const refused = await failure(loadPython(g.request, g.engine));
      expect(refused instanceof ModuleError ? refused.code : "", requested).toBe("package-not-shipped");
      expect(g.options).toEqual([]);
    }
    const needing = fixture(["pandas"], { lock: LOCK.replace('"file_name":"numpy-', '"file_name":"changed-numpy-') });
    expect(await failure(loadPython(needing.request, needing.engine))).toBeInstanceOf(ModuleError);
  });

  it("hands Pyodide a virtual index, the lock text, the bundled factory with the atomic signal poll, and the process environment", async () => {
    const f = fixture(["six"]);
    await loadPython(f.request, f.engine);
    expect(f.options).toHaveLength(1);
    const [given] = f.options;
    expect(given).toMatchObject({ indexURL: VIRTUAL_INDEX, packageBaseUrl: VIRTUAL_INDEX, lockFileContents: LOCK, env: { HOME: "/workspace", FOO: "bar" } });
    // The bundled factory, wrapped so that the interpreter's imports are prepared (withPreparedImports, below).
    const factory = given?.createPyodideModule;
    expect(factory).toBeTypeOf("function");
    expect(factory).not.toBe(f.engine.createPyodideModule);
    expect(given?.env).not.toBe(f.request.env);
  });

  it("instantiates the compiled interpreter for the interpreter's file while Pyodide starts, and nothing else", async () => {
    const seen: string[] = [];
    const f = fixture([], { during: async (scope, wasm) => {
      const marked = await scope.fetch(`${VIRTUAL_INDEX}pyodide.asm.wasm`);
      const instantiated = await wasm.instantiateStreaming(Promise.resolve(marked));
      seen.push(instantiated.module === COMPILED ? "compiled module" : "other module");
      seen.push(await wasm.instantiateStreaming(new Response("other")).then(() => "instantiated", (error: unknown) => (error instanceof Error ? error.message : "")));
    } });
    const original = f.wasm.instantiateStreaming;
    await loadPython(f.request, f.engine);
    expect(seen).toEqual(["compiled module", "the original instantiateStreaming"]);
    expect(f.events).toContain("instantiate the compiled interpreter");
    expect(f.wasm.instantiateStreaming).toBe(original);
    expect(f.asked).not.toContain("pyodide.asm.wasm");
  });

  it("serves the verified files at the virtual index only while Pyodide loads, and restores fetch afterwards", async () => {
    const seen: string[] = [];
    const f = fixture([], { during: async scope => {
      seen.push(await (await scope.fetch(`${VIRTUAL_INDEX}python_stdlib.zip`)).text());
      // No wheel is served while Pyodide starts, and the virtual host is never reached for real.
      seen.push(await scope.fetch(`${VIRTUAL_INDEX}${WHEELS.six}`).then(() => "served", () => "refused"));
      seen.push(await (await scope.fetch("https://example.com/other")).text());
    } });
    const before = f.scope.fetch;
    await loadPython(f.request, f.engine);
    expect(seen).toEqual(["content of python_stdlib.zip", "refused", "network"]);
    expect(f.scope.fetch).toBe(before);
    expect(f.network).toEqual(["https://example.com/other"]);
  });

  it("restores fetch and instantiateStreaming when Pyodide fails to start or to load a package, and passes the failure on unchanged", async () => {
    const startFailure = new Error("start failed"), packageFailure = new Error("package failed");
    const starting = fixture(["six"], { failLoad: startFailure });
    const before = starting.scope.fetch, beforeWasm = starting.wasm.instantiateStreaming;
    expect(await failure(loadPython(starting.request, starting.engine))).toBe(startFailure);
    expect([starting.scope.fetch, starting.wasm.instantiateStreaming]).toEqual([before, beforeWasm]);
    const packaging = fixture(["six"], { failPackages: packageFailure });
    const beforePackaging = packaging.scope.fetch;
    expect(await failure(loadPython(packaging.request, packaging.engine))).toBe(packageFailure);
    expect(packaging.scope.fetch).toBe(beforePackaging);
  });

  it("forwards what Pyodide reports as errors, and keeps its start-up output out of the way", async () => {
    const f = fixture(["six"]);
    await loadPython(f.request, f.engine);
    const [given] = f.options;
    given?.stdout?.("startup chatter");
    given?.stderr?.("a real error");
    expect(f.logs).toEqual(["a real error"]);
  });

  it("stops with the integrity failure itself, before Pyodide exists, when the runtime does not match its pin", async () => {
    const tampered = new Error("python_stdlib.zip does not match its sha256 pin");
    const f = fixture(["six"], { bytes: name => name === "python_stdlib.zip" ? Promise.reject(tampered) : Promise.resolve(name === "pyodide-lock.json" ? new TextEncoder().encode(LOCK) : new Uint8Array(1)) });
    const before = f.scope.fetch;
    expect(await failure(loadPython(f.request, f.engine))).toBe(tampered);
    expect(f.options).toEqual([]);
    expect(f.scope.fetch).toBe(before);
    const lockTampered = new Error("lock tampered");
    const g = fixture(["six"], { bytes: name => (name === "pyodide-lock.json" ? Promise.reject(lockTampered) : Promise.resolve(new Uint8Array(1))) });
    expect(await failure(loadPython(g.request, g.engine))).toBe(lockTampered);
    expect(g.options).toEqual([]);
  });
});

describe("installSync, when a program imports a package", () => {
  it("unpacks the package and what it needs, not yet loaded, from the verified copies read synchronously", async () => {
    const f = fixture(["six"]);
    const loaded = await loadPython(f.request, f.engine);
    expect(loaded.installSync(["pandas"])).toEqual(["numpy", "pandas", "python-dateutil", "six"]);
    // six was preloaded; the others are unpacked once, into site-packages, without Pyodide's asynchronous loadPackage.
    expect([...f.unpacked].sort()).toEqual([WHEELS.pandas, WHEELS.numpy, WHEELS["python-dateutil"]].map(wheel => `wheel /lib/python3.14/site-packages: content of ${wheel}`).sort());
    expect(f.loaded).toEqual([["six"]]);
    expect(loaded.installSync(["numpy"])).toEqual(["numpy", "pandas", "python-dateutil", "six"]);
    expect(f.unpacked).toHaveLength(3);
    expect(f.events.filter(event => event.startsWith("runPython"))).toHaveLength(1);
  });

  it("refuses a package the release does not carry before anything is read", async () => {
    const f = fixture([]);
    const loaded = await loadPython(f.request, f.engine);
    const asked = f.asked.length;
    expect(() => loaded.installSync(["scipy"])).toThrow(ModuleError);
    expect(f.asked).toHaveLength(asked);
    expect(f.unpacked).toEqual([]);
  });

  it("fails when Pyodide does not say where its site-packages are", async () => {
    const f = fixture([], { sitePackages: 42 });
    const loaded = await loadPython(f.request, f.engine);
    let thrown: unknown;
    try { loaded.installSync(["six"]); } catch (error: unknown) { thrown = error; }
    expect(thrown instanceof ModuleError ? thrown.code : thrown).toBe("package-install");
    expect(f.unpacked).toEqual([]);
  });

  it("maps top-level modules to the shipped packages that provide them, from the lock", async () => {
    const f = fixture([], { lock: JSON.stringify({ packages: {
      pillow: { file_name: WHEELS.pillow, imports: ["PIL"] },
      matplotlib: { file_name: WHEELS.matplotlib, imports: ["pylab", "mpl_toolkits", "matplotlib"] },
      scipy: { file_name: "scipy-1.whl", imports: ["scipy"] },
    } }) });
    const loaded = await loadPython(f.request, f.engine);
    expect(Object.fromEntries(loaded.imports)).toEqual({ PIL: "pillow", pylab: "matplotlib", mpl_toolkits: "matplotlib", matplotlib: "matplotlib" });
  });
});

describe("withPreparedImports", () => {
  /** A factory that instantiates nothing: from its async start it calls the hook with `imports`, as Emscripten does. */
  function fakeFactory(imports: Record<string, unknown>): { readonly factory: (settings: FactorySettings) => Promise<string>; readonly given: FactorySettings[] } {
    const given: FactorySettings[] = [];
    return {
      given,
      factory: async settings => {
        given.push(settings);
        await Promise.resolve();
        settings.instantiateWasm?.(imports, () => undefined);
        return "started";
      },
    };
  }

  it("prepares the imports with the module just before Pyodide's own hook instantiates the interpreter", async () => {
    const events: string[] = [], imports = { env: {} };
    const { factory, given } = fakeFactory(imports);
    const settings: FactorySettings = { instantiateWasm: seen => { events.push(seen === imports ? "instantiate the prepared imports" : "instantiate other imports"); } };
    const started = await withPreparedImports(factory, (seen, module) => { events.push(seen === imports && module === settings ? "prepare" : "prepare other"); })(settings);
    expect(started).toBe("started");
    expect(given).toEqual([settings]);
    expect(events).toEqual(["prepare", "instantiate the prepared imports"]);
  });

  it("fails when the factory is given no hook, and when preparing fails", async () => {
    const { factory, given } = fakeFactory({});
    await expect(withPreparedImports(factory, () => undefined)({})).rejects.toMatchObject({ name: "ModuleError", code: "interpreter-imports" });
    expect(given).toEqual([]);
    const failing = withPreparedImports(fakeFactory({}).factory, () => { throw new Error("cannot prepare"); });
    await expect(failing({ instantiateWasm: () => undefined })).rejects.toThrow("cannot prepare");
  });
});

describe("loadPython's imports", () => {
  it("makes the signal poll atomic and prepares the network's imports, in the factory it hands Pyodide", async () => {
    const f = fixture([]);
    await loadPython(f.request, f.engine);
    const handed = f.options[0]?.createPyodideModule;
    if (handed === undefined) throw new Error("no factory");
    const original = (): number => 0, env: Record<string, unknown> = { _Py_CheckEmscriptenSignals_Helper: original };
    const settings = { instantiateWasm: (imports: Record<string, unknown>) => { f.events.push(imports["env"] === env ? "instantiate" : "instantiate other"); } };
    // The engine's factory only rejects; calling Pyodide's hook directly shows what was prepared.
    await expect(Reflect.apply(handed, undefined, [settings])).rejects.toThrow("the factory is only handed over");
    settings.instantiateWasm({ env });
    expect(env["_Py_CheckEmscriptenSignals_Helper"]).not.toBe(original);
    expect(f.events.slice(-2)).toEqual(["networkImports", "instantiate"]);
  });
});
