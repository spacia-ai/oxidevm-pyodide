import { loadPyodide } from "pyodide";
import type { PyodideInterface } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import { VIRTUAL_INDEX, withScopedFetch } from "./artifact-fetch.ts";
import type { FetchScope } from "./artifact-fetch.ts";
import { ModuleError } from "./errors.ts";
import { decodeLockfile, wheelsFor } from "./lock.ts";
import { isWheelFile, RUNTIME_FILES } from "./shipped.ts";
import type { ShippedFile } from "./shipped.ts";

export type PyodideOptions = NonNullable<Parameters<typeof loadPyodide>[0]>;

/** What the loader asks of a started Pyodide: to load packages by name. The real one satisfies it; tests stand in for it. */
export interface PackageLoader {
  loadPackage(names: string[], options: { messageCallback: (message: string) => void; errorCallback: (message: string) => void }): Promise<unknown>;
}

/** The parts of the Pyodide package the loader drives, so that tests can stand in for them. */
export interface Engine<P extends PackageLoader = PyodideInterface> {
  readonly loadPyodide: (options: PyodideOptions) => Promise<P>;
  readonly createPyodideModule: NonNullable<PyodideOptions["createPyodideModule"]>;
  /** Where Pyodide finds `fetch`: the worker's global scope. */
  readonly scope: FetchScope;
}

/** The real Pyodide, bundled into the adapter. */
export const bundledEngine: Engine = { loadPyodide, createPyodideModule, scope: globalThis };

export interface LoadRequest {
  /** The packages to load, with everything they depend on. */
  readonly packages: readonly string[];
  /** Reads a release artifact, verified against its pin (`host.artifacts.bytes`). */
  readonly bytes: (name: ShippedFile) => Promise<Uint8Array<ArrayBuffer>>;
  /** The process environment Python starts with. */
  readonly env: Readonly<Record<string, string>>;
  /** Receives anything Pyodide reports as an error while it loads. */
  readonly log: (line: string) => void;
}

/**
 * Starts Pyodide from the release's own files. Everything it will read is fetched through `host.artifacts` first, so a
 * file that does not match its pin stops the module before Python starts (Pyodide itself would swallow a failed fetch of
 * its WebAssembly file and wait forever). Pyodide is then pointed at a virtual address, and a scoped `fetch` answers for
 * that address from the verified bytes while it loads, because a bundler renames staged files and Pyodide could not find
 * its siblings in a real directory. The factory comes from the bundle, so Pyodide never imports code at run time.
 */
export async function loadPython<P extends PackageLoader>(request: LoadRequest, engine: Engine<P>): Promise<P> {
  const lockBytes = await request.bytes("pyodide-lock.json");
  const lockText = new TextDecoder().decode(lockBytes);
  const wheels = wheelsFor(decodeLockfile(lockText), request.packages).map(wheel => {
    if (!isWheelFile(wheel.fileName)) throw new ModuleError("package-not-shipped", `The release carries no wheel for ${wheel.name}`);
    return wheel.fileName;
  });
  const names: ShippedFile[] = [...RUNTIME_FILES.filter(name => name !== "pyodide-lock.json"), ...wheels];
  const files = new Map<string, Uint8Array<ArrayBuffer>>([["pyodide-lock.json", lockBytes]]);
  for (const [name, bytes] of await Promise.all(names.map(async name => [name, await request.bytes(name)] as const))) files.set(name, bytes);

  return withScopedFetch(engine.scope, { index: VIRTUAL_INDEX, files }, async () => {
    const py = await engine.loadPyodide({
      indexURL: VIRTUAL_INDEX,
      packageBaseUrl: VIRTUAL_INDEX,
      lockFileContents: lockText,
      createPyodideModule: engine.createPyodideModule,
      env: { ...request.env },
      stdout: () => undefined,
      stderr: line => { request.log(line); },
    });
    if (request.packages.length > 0) await py.loadPackage([...request.packages], { messageCallback: () => undefined, errorCallback: line => { request.log(line); } });
    return py;
  });
}
