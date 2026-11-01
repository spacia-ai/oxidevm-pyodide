import type { PyodideInterface } from "pyodide";
import type { CommandLine, Program } from "./cli.ts";
import { exitStatus } from "./exit-status.ts";
import type { FileDescriptor, SyncFiles } from "./host-types.ts";
import { LINUX_ERRORS } from "./linux-errors.ts";
import { SCRIPT_RUNNER_SOURCE } from "./python/script-runner.ts";
import { normalizePath, within } from "./workspace-fs.ts";

/** The largest Python program the module reads, from a file or from standard input. */
export const MAX_SCRIPT_BYTES = 16 * 1024 ** 2;

/** argv[0] when the application starts the module itself (`spawnModule`), so that its messages read as in 0.1.0. */
export const HOST_ARGV0 = "pyodide";

/** How the process was started: argv[0] and the arguments after it, its directory, and the path of the command. */
export interface Launch {
  readonly argv0: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** `sys.executable`: the command's path, or "" for an application start, which has none (as CPython reports an unknown one). */
  readonly executable: string;
}

/** What the runner needs: the program's text and everything Python reports about how it was started. */
export interface ProgramRequest {
  /** The program's name in tracebacks: its absolute path, `<string>` for -c or `<stdin>`. */
  readonly filename: string;
  readonly source: string;
  readonly argv: readonly string[];
  readonly origArgv: readonly string[];
  readonly executable: string;
  /** `sys.path[0]`: the file's real directory, or "" (the working directory) for -c and standard input. */
  readonly path0: string;
  /** `__file__`, which CPython sets for a file and for standard input, but not for -c. */
  readonly file: string | null;
  /** Whether tracebacks may show the program's lines from memory, as CPython 3.13+ does for -c. */
  readonly cacheSource: boolean;
}

/** What preparing a program needs of the host: its synchronous files, the errno helper and standard input. */
export interface ProgramHost {
  readonly fs: Pick<SyncFiles, "readFile" | "read" | "realpath">;
  readonly errnoOf: (error: unknown) => number | undefined;
  readonly stdin: FileDescriptor;
}

export type Prepared =
  | { readonly kind: "ready"; readonly request: ProgramRequest }
  | { readonly kind: "failed"; readonly status: number; readonly message: string };

type RunLine = Extract<CommandLine, { kind: "run" }>;

/** The absolute path CPython gives a program file: the working directory joined with the name as typed, `.` and `..` kept. */
export function absoluteProgramPath(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  return cwd.endsWith("/") ? `${cwd}${path}` : `${cwd}/${path}`;
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * Why the program cannot run where it was started, or nothing: Python sees the VM's files only in `trees`, so the working
 * directory and a program file must be inside them. A command run elsewhere stops before Python loads, instead of
 * running somewhere else.
 */
export function placementRefusal(argv0: string, cwd: string, line: RunLine, trees: readonly string[]): string | undefined {
  const places = [normalizePath(cwd)];
  if (line.program.kind === "file") places.push(directoryOf(normalizePath(absoluteProgramPath(line.program.path, cwd))));
  const outside = places.find(place => !trees.some(tree => within(place, tree)));
  return outside === undefined ? undefined : `${argv0}: cannot run in '${outside}': this Python sees the VM's files only under /workspace, /tmp and $HOME`;
}

/**
 * The environment Python starts with: the process's own, with Matplotlib set to draw to files (a worker has no display).
 * Variables that configure the VM's native Python are left out, because the interpreter here is another one, and
 * `PYTHONHOME` or `PYTHONPATH` of the VM would only mislead it.
 */
export function pythonEnvironment(inherited: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const own = Object.entries(inherited).filter(([name]) => !name.startsWith("PYTHON"));
  return { MPLBACKEND: "Agg", ...Object.fromEntries(own) };
}

/** The reason a host call failed, as Python words an OSError: `[Errno 2] No such file or directory`. */
function reasonOf(error: unknown, errnoOf: ProgramHost["errnoOf"]): string {
  const errno = errnoOf(error);
  const info = errno === undefined ? undefined : LINUX_ERRORS.get(errno);
  if (errno !== undefined && info !== undefined) return `[Errno ${String(errno)}] ${info.text}`;
  return error instanceof Error ? error.message : "unreadable";
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function readFileProgram(host: ProgramHost, argv0: string, path: string): Prepared | string {
  let bytes: Uint8Array;
  try {
    bytes = host.fs.readFile(path, MAX_SCRIPT_BYTES);
  } catch (error: unknown) {
    return { kind: "failed", status: 2, message: `${argv0}: can't open file '${path}': ${reasonOf(error, host.errnoOf)}` };
  }
  return decode(bytes) ?? { kind: "failed", status: 1, message: `${argv0}: ${path} is not valid UTF-8 text` };
}

/** Reads standard input to its end, refusing more than the limit without reading much beyond it. */
function readInputProgram(host: ProgramHost, argv0: string): Prepared | string {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = host.fs.read(host.stdin, Math.min(1024 ** 2, MAX_SCRIPT_BYTES + 1 - size));
      if (chunk.length === 0) break;
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_SCRIPT_BYTES) return { kind: "failed", status: 1, message: `${argv0}: the program on standard input is larger than 16 MiB` };
    }
  } catch (error: unknown) {
    return { kind: "failed", status: 1, message: `${argv0}: can't read the program on standard input: ${reasonOf(error, host.errnoOf)}` };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return decode(bytes) ?? { kind: "failed", status: 1, message: `${argv0}: the program on standard input is not valid UTF-8 text` };
}

/** `sys.path[0]` for a file: the directory of its real path, as CPython resolves it; the name's own directory when that fails. */
function scriptDirectory(host: ProgramHost, path: string): string {
  try {
    return directoryOf(host.fs.realpath(path));
  } catch {
    return directoryOf(normalizePath(path));
  }
}

/** Reads the program and describes it the way CPython would to the program itself. */
export function prepareProgram(host: ProgramHost, launch: Launch, line: RunLine): Prepared {
  const program: Program = line.program;
  const common = { argv: line.argv, origArgv: [launch.argv0, ...launch.args], executable: launch.executable };
  switch (program.kind) {
    case "code":
      // CPython ends the text of -c with a newline before it compiles it.
      return { kind: "ready", request: { ...common, filename: "<string>", source: `${program.code}\n`, path0: "", file: null, cacheSource: true } };
    case "stdin": {
      const text = readInputProgram(host, launch.argv0);
      if (typeof text !== "string") return text;
      return { kind: "ready", request: { ...common, filename: "<stdin>", source: text, path0: "", file: "<stdin>", cacheSource: false } };
    }
    case "file": {
      const path = absoluteProgramPath(program.path, launch.cwd);
      const text = readFileProgram(host, launch.argv0, path);
      if (typeof text !== "string") return text;
      return { kind: "ready", request: { ...common, filename: path, source: text, path0: scriptDirectory(host, path), file: path, cacheSource: false } };
    }
  }
}

/** Runs the program in a Pyodide that is ready, and returns the exit status it asked for. */
export async function runProgram(py: PyodideInterface, request: ProgramRequest): Promise<number> {
  // The runner gets a namespace of its own, so that neither its names nor the request appear in the program's globals.
  const namespace: unknown = py.toPy({
    _request: {
      filename: request.filename, source: request.source, argv: [...request.argv], orig_argv: [...request.origArgv], executable: request.executable,
      path0: request.path0, file: request.file, cache_source: request.cacheSource,
    },
  });
  if (!(namespace instanceof py.ffi.PyProxy)) throw new Error("Pyodide did not convert the request to a Python dict");
  try {
    const status: unknown = await py.runPythonAsync(SCRIPT_RUNNER_SOURCE, { globals: namespace, filename: "<oxidevm-runner>", dedent: false });
    return exitStatus(status);
  } finally {
    namespace.destroy();
  }
}
