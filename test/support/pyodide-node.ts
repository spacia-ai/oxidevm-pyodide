import { createRequire } from "node:module";
import { dirname } from "node:path";
import { loadPyodide } from "pyodide";
import type { PyodideInterface } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import { withPreparedImports } from "../../src/python-loader.ts";
import { useAtomicSignalPoll } from "../../src/signals.ts";

/**
 * Starts the real Pyodide runtime in Node, from the copy the `pyodide` package installed. The tests that use it check
 * this module's code against Pyodide's real file system and interpreter. Node 26 or later has WebAssembly JSPI, which
 * `pyodide.ffi.run_sync` needs; Node 24 needs `--experimental-wasm-jspi`. Like the adapter (src/python-loader.ts), it
 * prepares the interpreter's imports: the atomic signal poll.
 */
export async function startPyodide(env: Readonly<Record<string, string>> = {}): Promise<PyodideInterface> {
  const root = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
  return loadPyodide({ indexURL: `${root}/`, createPyodideModule: withPreparedImports(createPyodideModule, (imports, module) => { useAtomicSignalPoll(imports, module); }), env: { ...env }, stdout: () => undefined, stderr: () => undefined });
}
