import { LinuxError } from "@oxidevm/sdk/js-process";
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/cli.ts";
import type { CommandLine } from "../src/cli.ts";
import { absoluteProgramPath, MAX_SCRIPT_BYTES, placementRefusal, prepareProgram, pythonEnvironment } from "../src/script.ts";
import type { Launch, ProgramHost } from "../src/script.ts";
import { normalizePath } from "../src/workspace-fs.ts";
import { descriptor } from "./support/brands.ts";

// What the command does before Python starts: where the program is, whether it may run there, its text, and what Python
// will report about how it was started. The runner itself is tested in script-runner.test.ts.

const COMMAND: Launch = { argv0: "python3", args: [], cwd: "/workspace/project", executable: "/usr/local/bin/python3" };
const STDIN = descriptor(0);

function line(args: readonly string[]): Extract<CommandLine, { kind: "run" }> {
  const parsed = parseCommandLine(args);
  if (parsed.kind !== "run") throw new Error(`not a program: ${args.join(" ")}`);
  return parsed;
}

const errnoOf = (error: unknown): number | undefined => (error instanceof LinuxError ? error.errno : undefined);
const throwValue = (value: unknown): never => { throw value; };

/** A host whose files are these texts (or errors), whose standard input is `input`, and whose realpath follows `links`. */
function host(options: { readonly files?: Readonly<Record<string, string | Uint8Array | number>>; readonly input?: Uint8Array; readonly links?: Readonly<Record<string, string>> } = {}): ProgramHost & { readonly asked: { path: string; maxBytes: number | undefined }[]; readonly reads: number[] } {
  let input = options.input ?? new Uint8Array(0);
  const asked: { path: string; maxBytes: number | undefined }[] = [], reads: number[] = [];
  return {
    asked, reads, stdin: STDIN, errnoOf,
    fs: {
      readFile(path, maxBytes) {
        const name = typeof path === "string" ? path : "";
        asked.push({ path: name, maxBytes });
        // The VM resolves . and .. as it walks the name.
        const found = options.files?.[normalizePath(name)];
        if (found === undefined) throw new LinuxError(2);
        if (typeof found === "number") throw new LinuxError(found);
        return typeof found === "string" ? new TextEncoder().encode(found) : found;
      },
      read(fd, count) {
        if (fd !== STDIN) throw new LinuxError(9);
        reads.push(count);
        const bytes = input.slice(0, count);
        input = input.slice(count);
        return bytes;
      },
      realpath(path) {
        const name = typeof path === "string" ? path : "";
        return options.links?.[name] ?? name;
      },
    },
  };
}

describe("absoluteProgramPath", () => {
  it("joins a relative name to the working directory as CPython does, without resolving . or ..", () => {
    expect(absoluteProgramPath("tool.py", "/workspace/project")).toBe("/workspace/project/tool.py");
    expect(absoluteProgramPath("./sub/../tool.py", "/tmp")).toBe("/tmp/./sub/../tool.py");
    expect(absoluteProgramPath("/workspace/a.py", "/tmp")).toBe("/workspace/a.py");
    expect(absoluteProgramPath("a.py", "/")).toBe("/a.py");
  });
});

describe("placementRefusal", () => {
  const trees = ["/workspace", "/tmp", "/home/user"];
  const refusal = (place: string): string => `python3: cannot run in '${place}': this Python sees the VM's files only under /workspace, /tmp and $HOME`;

  it("lets a program run when the working directory and the file are in trees Python sees", () => {
    expect(placementRefusal("python3", "/workspace/project", line(["tool.py"]), trees)).toBeUndefined();
    expect(placementRefusal("python3", "/tmp", line(["/home/user/bin/tool.py"]), trees)).toBeUndefined();
    expect(placementRefusal("python3", "/home/user", line(["-c", "pass"]), trees)).toBeUndefined();
    expect(placementRefusal("python3", "/workspace", line([]), trees)).toBeUndefined();
  });

  it("refuses a working directory outside them, whatever the program", () => {
    for (const cwd of ["/", "/etc", "/home", "/workspace2", "/usr/lib"]) {
      for (const args of [["-c", "pass"], [], ["/workspace/x.py"]]) expect(placementRefusal("python3", cwd, line(args), trees), `${cwd} ${args.join(" ")}`).toBe(refusal(cwd));
    }
  });

  it("refuses a program file outside them, naming its directory, also when .. leads out", () => {
    expect(placementRefusal("python3", "/workspace", line(["/etc/tool.py"]), trees)).toBe(refusal("/etc"));
    expect(placementRefusal("python3", "/workspace", line(["../usr/lib/tool.py"]), trees)).toBe(refusal("/usr/lib"));
    expect(placementRefusal("python3", "/workspace", line(["../tool.py"]), trees)).toBe(refusal("/"));
  });

  it("names the command as it was typed and the directory as Linux resolves it", () => {
    expect(placementRefusal("/usr/local/bin/python", "/etc/./ssl/", line([]), trees)).toBe("/usr/local/bin/python: cannot run in '/etc/ssl': this Python sees the VM's files only under /workspace, /tmp and $HOME");
  });
});

describe("pythonEnvironment", () => {
  it("passes the process environment on, HOME included, and defaults Matplotlib to files", () => {
    expect(pythonEnvironment({ PATH: "/usr/bin", HOME: "/home/user", LANG: "C.UTF-8" })).toEqual({ MPLBACKEND: "Agg", PATH: "/usr/bin", HOME: "/home/user", LANG: "C.UTF-8" });
    expect(pythonEnvironment({ PATH: "/usr/bin" })).toEqual({ MPLBACKEND: "Agg", PATH: "/usr/bin" });
  });

  it("lets the process choose another Matplotlib backend", () => {
    expect(pythonEnvironment({ MPLBACKEND: "svg" })).toMatchObject({ MPLBACKEND: "svg" });
  });

  it("leaves out the settings of the VM's own Python", () => {
    const environment = pythonEnvironment({ PYTHONHOME: "/usr", PYTHONPATH: "/x", PYTHONSTARTUP: "/s", PYTHONUNBUFFERED: "1", PYTHON_FOO: "1", NOTPYTHON: "kept", PY: "kept" });
    expect(Object.keys(environment).sort()).toEqual(["MPLBACKEND", "NOTPYTHON", "PY"]);
  });

  it("does not change what it was given", () => {
    const given = { PATH: "/bin" };
    pythonEnvironment(given);
    expect(given).toEqual({ PATH: "/bin" });
  });
});

/** What a request without -m, -i or a prompt carries besides the program. */
const SOURCE = { run: "source", module: "", interactive: false, banner: false, argv0: "python3" } as const;

describe("prepareProgram from a file", () => {
  it("reads the file, at most 16 MiB of it, and describes it as CPython would: absolute name, sys.path[0] its real directory", () => {
    const files = host({ files: { "/workspace/project/tool.py": "print('héllo')\n" }, links: { "/workspace/project/tool.py": "/workspace/tools/real.py" } });
    expect(prepareProgram(files, { ...COMMAND, args: ["tool.py", "a"] }, line(["tool.py", "a"]))).toEqual({
      kind: "ready",
      request: {
        ...SOURCE, filename: "/workspace/project/tool.py", source: "print('héllo')\n", argv: ["tool.py", "a"], origArgv: ["python3", "tool.py", "a"],
        executable: "/usr/local/bin/python3", path0: "/workspace/tools", file: "/workspace/project/tool.py", cacheSource: false,
      },
    });
    expect(files.asked).toEqual([{ path: "/workspace/project/tool.py", maxBytes: MAX_SCRIPT_BYTES }]);
    expect(MAX_SCRIPT_BYTES).toBe(16 * 1024 ** 2);
  });

  it("puts the directory of the file on sys.path when its real path cannot be found", () => {
    const files = host({ files: { "/workspace/a/b.py": "" } });
    const broken: ProgramHost = { ...files, fs: { ...files.fs, realpath: () => { throw new LinuxError(2); } } };
    expect(prepareProgram(broken, { ...COMMAND, args: ["../a/./b.py"] }, line(["../a/./b.py"]))).toMatchObject({ kind: "ready", request: { filename: "/workspace/project/../a/./b.py", path0: "/workspace/a" } });
  });

  it("words a file that cannot be opened as CPython does, after argv[0], with status 2", () => {
    const missing = prepareProgram(host(), { ...COMMAND, args: ["gone.py"] }, line(["gone.py"]));
    expect(missing).toEqual({ kind: "failed", status: 2, message: "python3: can't open file '/workspace/project/gone.py': [Errno 2] No such file or directory" });
    const denied = prepareProgram(host({ files: { "/workspace/x.py": 13 } }), { ...COMMAND, argv0: "pyodide" }, line(["/workspace/x.py"]));
    expect(denied).toEqual({ kind: "failed", status: 2, message: "pyodide: can't open file '/workspace/x.py': [Errno 13] Permission denied" });
    expect(prepareProgram(host({ files: { "/workspace/x.py": 21 } }), COMMAND, line(["/workspace/x.py"]))).toMatchObject({ message: "python3: can't open file '/workspace/x.py': [Errno 21] Is a directory" });
  });

  it("gives the host's own message for an error it has no wording for", () => {
    expect(prepareProgram(host({ files: { "/workspace/x.py": 999 } }), COMMAND, line(["/workspace/x.py"]))).toMatchObject({ message: "python3: can't open file '/workspace/x.py': Linux operation failed with errno 999" });
    const plain: ProgramHost = { ...host(), fs: { ...host().fs, readFile: () => { throw new Error("plain"); } } };
    expect(prepareProgram(plain, COMMAND, line(["/workspace/x.py"]))).toMatchObject({ message: "python3: can't open file '/workspace/x.py': plain" });
    const odd: ProgramHost = { ...host(), fs: { ...host().fs, readFile: () => throwValue("not an error") } };
    expect(prepareProgram(odd, COMMAND, line(["/workspace/x.py"]))).toMatchObject({ message: "python3: can't open file '/workspace/x.py': unreadable" });
  });

  it("refuses text that is not UTF-8 with status 1, and drops a byte order mark as Python does", () => {
    expect(prepareProgram(host({ files: { "/workspace/x.py": Uint8Array.of(0x70, 0xff, 0xfe) } }), COMMAND, line(["/workspace/x.py"]))).toEqual({ kind: "failed", status: 1, message: "python3: /workspace/x.py is not valid UTF-8 text" });
    expect(prepareProgram(host({ files: { "/workspace/x.py": Uint8Array.of(0xef, 0xbb, 0xbf, 0x78) } }), COMMAND, line(["/workspace/x.py"]))).toMatchObject({ kind: "ready", request: { source: "x" } });
  });
});

describe("prepareProgram from -c", () => {
  it("runs the text after -c as <string>, with a newline as CPython adds, from the working directory, kept for tracebacks", () => {
    expect(prepareProgram(host(), { ...COMMAND, args: ["-uc", "print(1)", "x"] }, line(["-uc", "print(1)", "x"]))).toEqual({
      kind: "ready",
      request: { ...SOURCE, filename: "<string>", source: "print(1)\n", argv: ["-c", "x"], origArgv: ["python3", "-uc", "print(1)", "x"], executable: "/usr/local/bin/python3", path0: "", file: null, cacheSource: true },
    });
  });
});

describe("prepareProgram from -m", () => {
  it("names the module for runpy, reads nothing, and puts the working directory first on sys.path as CPython does", () => {
    const files = host();
    expect(prepareProgram(files, { ...COMMAND, args: ["-m", "json.tool", "x"] }, line(["-m", "json.tool", "x"]))).toEqual({
      kind: "ready",
      request: { ...SOURCE, run: "module", module: "json.tool", filename: "", source: "", argv: ["-m", "x"], origArgv: ["python3", "-m", "json.tool", "x"], executable: "/usr/local/bin/python3", path0: "/workspace/project", file: null, cacheSource: false },
    });
    expect(files.asked).toEqual([]);
  });
});

describe("prepareProgram for the interactive interpreter", () => {
  it("reads nothing from a terminal: the program is typed at the prompt, after the banner", () => {
    const input = host({ input: new TextEncoder().encode("never read\n") });
    const terminal: ProgramHost = { ...input, stdinIsTerminal: true, fs: { ...input.fs, read: () => { throw new Error("standard input was read before the prompt"); } } };
    expect(prepareProgram(terminal, COMMAND, line([]))).toEqual({
      kind: "ready",
      request: { ...SOURCE, run: "none", interactive: true, banner: true, filename: "<stdin>", source: "", argv: [""], origArgv: ["python3"], executable: "/usr/local/bin/python3", path0: "", file: null, cacheSource: false },
    });
    expect(prepareProgram(terminal, { ...COMMAND, args: ["-q", "-", "a"] }, line(["-q", "-", "a"]))).toMatchObject({ kind: "ready", request: { run: "none", interactive: true, banner: false, argv: ["-", "a"] } });
  });

  it("prompts on a pipe with -i, and keeps the program of -c or a file before the prompt, without a banner", () => {
    expect(prepareProgram(host(), COMMAND, line(["-i"]))).toMatchObject({ kind: "ready", request: { run: "none", interactive: true, banner: true } });
    expect(prepareProgram(host(), COMMAND, line(["-i", "-c", "x = 1"]))).toMatchObject({ kind: "ready", request: { run: "source", interactive: true, banner: false, source: "x = 1\n" } });
    expect(prepareProgram({ ...host(), stdinIsTerminal: true }, COMMAND, line(["-c", "pass"]))).toMatchObject({ kind: "ready", request: { run: "source", interactive: false, banner: false } });
  });
});

describe("prepareProgram from standard input", () => {
  it("reads standard input to its end and runs it as <stdin>, with __file__ <stdin> as CPython sets it", () => {
    const input = host({ input: new TextEncoder().encode("import sys\nprint(sys.argv)\n") });
    expect(prepareProgram(input, { ...COMMAND, args: ["-", "a"] }, line(["-", "a"]))).toEqual({
      kind: "ready",
      request: { ...SOURCE, filename: "<stdin>", source: "import sys\nprint(sys.argv)\n", argv: ["-", "a"], origArgv: ["python3", "-", "a"], executable: "/usr/local/bin/python3", path0: "", file: "<stdin>", cacheSource: false },
    });
    expect(prepareProgram(host(), COMMAND, line([]))).toMatchObject({ kind: "ready", request: { source: "", argv: [""], origArgv: ["python3"] } });
  });

  it("reads 16 MiB at most and refuses more with status 1, without reading all of it", () => {
    const exact = host({ input: new Uint8Array(MAX_SCRIPT_BYTES).fill(0x23) });
    const read = prepareProgram(exact, COMMAND, line([]));
    expect(read.kind === "ready" ? read.request.source.length : -1).toBe(MAX_SCRIPT_BYTES);
    const larger = host({ input: new Uint8Array(MAX_SCRIPT_BYTES + 4096).fill(0x23) });
    expect(prepareProgram(larger, COMMAND, line(["-"]))).toEqual({ kind: "failed", status: 1, message: "python3: the program on standard input is larger than 16 MiB" });
    expect(larger.reads.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(MAX_SCRIPT_BYTES + 1);
  });

  it("refuses input that is not UTF-8 text with status 1", () => {
    expect(prepareProgram(host({ input: Uint8Array.of(0xff, 0xfe, 0x0a) }), COMMAND, line([]))).toEqual({ kind: "failed", status: 1, message: "python3: the program on standard input is not valid UTF-8 text" });
  });

  it("reports a standard input that cannot be read as the errno it is, with status 1", () => {
    const failing: ProgramHost = { ...host(), fs: { ...host().fs, read: () => { throw new LinuxError(5); } } };
    expect(prepareProgram(failing, COMMAND, line([]))).toEqual({ kind: "failed", status: 1, message: "python3: can't read the program on standard input: [Errno 5] Input/output error" });
  });
});
