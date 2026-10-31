import type { PyodideInterface } from "pyodide";
import { WORKSPACE } from "./workspace-fs.ts";
import { exitStatus } from "./exit-status.ts";
import { LINUX_ERRORS } from "./linux-errors.ts";
import { SCRIPT_RUNNER_SOURCE } from "./python/script-runner.ts";

/** The largest Python program the module reads. */
export const MAX_SCRIPT_BYTES = 16 * 1024 ** 2;

export const USAGE = "usage: pyodide <script.py> [argument ...]";

/** What the process was asked to run: `script` as typed, its absolute `path`, and the arguments after it. */
export interface Invocation {
  readonly script: string;
  readonly path: string;
  readonly arguments: readonly string[];
}

/** Reads the command line: the first argument is the Python program, the rest are its arguments. */
export function invocationOf(args: readonly string[], cwd: string): Invocation | undefined {
  const [script, ...rest] = args;
  if (script === undefined || script === "") return undefined;
  return { script, path: script.startsWith("/") ? script : `${cwd}/${script}`, arguments: rest };
}

/** Where Python starts: the process's directory when it is in the workspace, otherwise the workspace itself. */
export function workingDirectory(cwd: string): string {
  return cwd === WORKSPACE || cwd.startsWith(`${WORKSPACE}/`) ? cwd : WORKSPACE;
}

/**
 * The environment Python starts with: the process's own, with `HOME` in the workspace and Matplotlib set to draw to
 * files (a worker has no display). Variables that configure the VM's native Python are left out, because the interpreter
 * here is another one, and `PYTHONHOME` or `PYTHONPATH` of the VM would only mislead it.
 */
export function pythonEnvironment(inherited: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const own = Object.entries(inherited).filter(([name]) => !name.startsWith("PYTHON"));
  return { MPLBACKEND: "Agg", ...Object.fromEntries(own), HOME: WORKSPACE };
}

export type ScriptSource = { readonly kind: "source"; readonly text: string } | { readonly kind: "unreadable"; readonly message: string };

/** Reads the program's text from the VM, as `python script.py` would, reporting the failure the way Python words it. */
export function readScript(files: { readFile(path: string, maxBytes?: number): Uint8Array }, errnoOf: (error: unknown) => number | undefined, invocation: Invocation): ScriptSource {
  let bytes: Uint8Array;
  try {
    bytes = files.readFile(invocation.path, MAX_SCRIPT_BYTES);
  } catch (error: unknown) {
    const errno = errnoOf(error);
    const info = errno === undefined ? undefined : LINUX_ERRORS.get(errno);
    const reason = info === undefined ? (error instanceof Error ? error.message : "unreadable") : `[Errno ${String(errno)}] ${info.text}`;
    return { kind: "unreadable", message: `pyodide: can't open file '${invocation.path}': ${reason}` };
  }
  try {
    return { kind: "source", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "unreadable", message: `pyodide: ${invocation.path} is not valid UTF-8 text` };
  }
}

/** Runs the program in a Pyodide that is ready, and returns the exit status it asked for. */
export async function runScript(py: PyodideInterface, invocation: Invocation, text: string): Promise<number> {
  // The runner gets a namespace of its own, so that neither its names nor the request appear in the program's globals.
  const namespace: unknown = py.toPy({ _request: { path: invocation.path, source: text, argv: [invocation.script, ...invocation.arguments] } });
  if (!(namespace instanceof py.ffi.PyProxy)) throw new Error("Pyodide did not convert the request to a Python dict");
  try {
    const status: unknown = await py.runPythonAsync(SCRIPT_RUNNER_SOURCE, { globals: namespace, filename: "<oxidevm-runner>", dedent: false });
    return exitStatus(status);
  } finally {
    namespace.destroy();
  }
}
