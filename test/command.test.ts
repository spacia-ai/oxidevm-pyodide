import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { kit } from "@oxidevm/sdk/wasm";
import type { CommandIO, Terminals } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PYTHON_VERSION } from "../src/cli.ts";
import { createCommand } from "../src/command.ts";
import type { CommandHost } from "../src/host-types.ts";
import type { Engine, PyodideOptions } from "../src/python-loader.ts";
import type { PythonCommand, ShippedFile } from "../src/shipped.ts";
import { processId } from "./support/brands.ts";
import { normalised, oracle, oracleFiles, recordedOutcome } from "./support/cpython-oracle.ts";
import { fakeProcess } from "./support/fake-process.ts";
import { echoUpperCase, fakeSockets } from "./support/fake-sockets.ts";
import { fakeStdio } from "./support/fake-stdio.ts";
import { nodeFiles } from "./support/node-files.ts";
import { startPyodide } from "./support/pyodide-node.ts";

// The command end to end in Node: the real Pyodide, started from node_modules instead of the virtual index (a Node
// loader cannot use one), against fakes of the VM's files (/workspace, /tmp and /home/user), processes and sockets.

type Invocation = CommandIO<PythonCommand>["invocation"];

const PYTHON3: Invocation = { kind: "command", name: "python3", path: "/usr/local/bin/python3", argv0: "python3" };
const PYTHON: Invocation = { kind: "command", name: "python", path: "/usr/local/bin/python", argv0: "python" };
const APPLICATION: Invocation = { kind: "host" };
const NO_TERMINALS: Terminals = { stdin: false, stdout: false, stderr: false };

interface MainOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly invocation?: Invocation;
  readonly terminals?: Partial<Terminals>;
  readonly stdin?: string;
}

interface Setup {
  readonly host: CommandHost;
  readonly main: (args: readonly string[], options?: MainOptions) => Promise<number>;
  readonly close: () => Promise<void>;
  readonly failures: string[];
  readonly logs: string[];
  readonly artifactsRead: ShippedFile[];
  readonly startedWith: PyodideOptions[];
  readonly sockets: ReturnType<typeof fakeSockets>;
  readonly stdio: ReturnType<typeof fakeStdio>;
  /** The directory of the test machine behind a VM path. */
  readonly real: (path: string) => string;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pyodide-command-"));
  for (const tree of ["workspace", "tmp", "home"]) await mkdir(join(root, tree));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(options: { readonly bytes?: CommandHost["artifacts"]["bytes"]; readonly fs?: (files: ReturnType<typeof nodeFiles>["files"]) => CommandHost["fs"] } = {}): Setup {
  const stdio = fakeStdio();
  const files = nodeFiles({ "/workspace": join(root, "workspace"), "/tmp": join(root, "tmp"), "/home/user": join(root, "home") }, stdio.files);
  const children = fakeProcess(() => ({}));
  const sockets = fakeSockets();
  sockets.listen("unix:/workspace/_oxidevm/echo.sock", echoUpperCase());
  const failures: string[] = [], logs: string[] = [], artifactsRead: ShippedFile[] = [], startedWith: PyodideOptions[] = [];
  const toStderr = (text: string): void => { stdio.files.writeAll(stdio.streams.stderr, new TextEncoder().encode(`${text}\n`)); };
  const lifetime = new AbortController();
  // `log` and `fail` write their line to standard error, as the runner's host does.
  const host: CommandHost = {
    signal: lifetime.signal,
    options: { packages: [] },
    artifacts: { bytes: options.bytes ?? ((name) => { artifactsRead.push(name); return Promise.resolve(new TextEncoder().encode(name === "pyodide-lock.json" ? '{"packages":{}}' : name)); }) },
    kit,
    stdio: stdio.streams,
    fs: options.fs?.(files.files) ?? files.files,
    files: children.host.files,
    sockets: sockets.sockets,
    process: { ...children.host.process, info: () => Promise.resolve({ pid: processId(777), parentPid: null, uid: 1000, gid: 100, cwd: "/workspace", args: [], environment: [], terminal: null }) },
    log: line => { logs.push(line); toStderr(line); },
    fail: (status, message) => { failures.push(`${String(status)}: ${message}`); toStderr(message); return status; },
  };
  const engine: Engine = {
    scope: { fetch: () => Promise.reject(new Error("no network in tests")) },
    createPyodideModule: () => Promise.reject(new Error("not used: Node starts Pyodide from node_modules")),
    loadPyodide: options => { startedWith.push(options); return startPyodide(options.env); },
  };
  const command = createCommand(host, engine);
  return {
    host, failures, logs, artifactsRead, startedWith, sockets, stdio, real: files.real,
    main: (args, given = {}) => {
      stdio.feed(given.stdin ?? "");
      const io: CommandIO<PythonCommand> = {
        args, env: given.env ?? { PATH: "/usr/bin", HOME: "/home/user" }, cwd: given.cwd ?? "/workspace",
        stdin: stdio.streams.stdin, stdout: stdio.streams.stdout, stderr: stdio.streams.stderr,
        invocation: given.invocation ?? PYTHON3, terminals: { ...NO_TERMINALS, ...given.terminals },
      };
      return Promise.resolve(command.main(io));
    },
    close: async () => { await command.close?.(); lifetime.abort(); },
  };
}

/** Writes the recorded programs where the recording ran them, under the VM's /tmp. */
async function writeOracleFiles(s: Setup): Promise<void> {
  for (const [path, text] of oracleFiles()) {
    await mkdir(dirname(s.real(path)), { recursive: true });
    await writeFile(s.real(path), text);
  }
}

describe("a command that answers without starting Python", () => {
  const MODULE = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };
  // The recorded cases that CPython answered from its command line alone, or with a file it could not open.
  const cases = oracle.cases.filter(recorded => recordedOutcome(recorded) !== "run" || recorded.stderr.includes("can't open file"));

  it("covers -V, -h, usage errors, a parser warning and a missing file", () => {
    expect(new Set(cases.map(recordedOutcome))).toEqual(new Set(["version", "help", "usage-error", "run"]));
    for (const name of ["missing-file", "empty-long-option-ends-options"]) expect(cases.map(recorded => recorded.name)).toContain(name);
  });

  for (const recorded of cases) {
    it(`${recorded.name}: prints what CPython 3.14 prints and exits as it does`, async () => {
      const s = setup();
      await writeOracleFiles(s);
      const status = await s.main(recorded.argv.slice(1), { cwd: oracle.provenance.cwd, stdin: recorded.stdin });
      const { stdout, stderr } = s.stdio.take();
      expect({ status, stdout: recorded.stdoutKept === "first-line" ? `${stdout.split("\n")[0] ?? ""}\n` : stdout, stderr })
        .toEqual({ status: recorded.exit.kind === "exited" ? recorded.exit.code : -1, stdout: normalised(recorded.stdout, MODULE), stderr: normalised(recorded.stderr, MODULE) });
      expect(s.startedWith).toEqual([]);
      expect(s.artifactsRead).toEqual([]);
    });
  }

  it("prints the version and the help even when nobody reads them, as CPython does", async () => {
    const s = setup({ fs: files => ({ ...files, writeAll: (fd, bytes) => { if (fd === 1) throw new LinuxError(32); files.writeAll(fd, bytes); } }) });
    expect(await s.main(["-V"])).toBe(0);
    expect(await s.main(["--help"])).toBe(0);
  });

  it("refuses the interactive interpreter: no program with a terminal on standard input, and -i", async () => {
    const s = setup();
    const refusal = "the interactive interpreter is not supported yet; use FILE, -c CODE or -";
    expect(await s.main([], { terminals: { stdin: true } })).toBe(2);
    expect(await s.main(["-"], { terminals: { stdin: true }, invocation: PYTHON })).toBe(2);
    expect(await s.main(["-i", "-c", "pass"])).toBe(2);
    expect(s.failures).toEqual([`2: python3: ${refusal}`, `2: python: ${refusal}`, `2: python3: ${refusal}`]);
    expect(s.startedWith).toEqual([]);
  });

  it("refuses to run in a directory Python cannot see, or a file there, instead of running somewhere else", async () => {
    const s = setup();
    const where = (place: string): string => `2: python3: cannot run in '${place}': this Python sees the VM's files only under /workspace, /tmp and $HOME`;
    expect(await s.main(["-c", "pass"], { cwd: "/" })).toBe(2);
    expect(await s.main([], { cwd: "/etc" })).toBe(2);
    expect(await s.main(["/usr/lib/tool.py"])).toBe(2);
    // Without HOME, the home directory is not a tree Python sees.
    expect(await s.main(["-c", "pass"], { cwd: "/home/user", env: { PATH: "/usr/bin" } })).toBe(2);
    expect(s.failures).toEqual([where("/"), where("/etc"), where("/usr/lib"), where("/home/user")]);
    expect(s.startedWith).toEqual([]);
  });

  it("names itself pyodide when the application starts it, as 0.1.0 did", async () => {
    const s = setup();
    expect(await s.main(["/workspace/missing.py"], { invocation: APPLICATION })).toBe(2);
    expect(await s.main(["-Z"], { invocation: APPLICATION })).toBe(2);
    expect(s.failures).toEqual([
      "2: pyodide: can't open file '/workspace/missing.py': [Errno 2] No such file or directory",
      "2: Unknown option: -Z\nusage: pyodide [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry `python -h' for more information.",
    ]);
  });

  it("answers a program that is not text with status 1", async () => {
    await writeFile(join(root, "workspace/binary.py"), Uint8Array.of(0x70, 0xff, 0xfe));
    const s = setup();
    expect(await s.main(["/workspace/binary.py"])).toBe(1);
    expect(s.failures).toEqual(["1: python3: /workspace/binary.py is not valid UTF-8 text"]);
  });

  it("lets a file that does not match its pin stop it, as the runner's integrity failure, not as a status", async () => {
    await writeFile(join(root, "workspace/ok.py"), "print('never runs')");
    const tampered = new Error("pyodide.asm.wasm does not match its sha256 pin");
    const s = setup({ bytes: name => (name === "pyodide.asm.wasm" ? Promise.reject(tampered) : Promise.resolve(new TextEncoder().encode(name === "pyodide-lock.json" ? '{"packages":{}}' : "x"))) });
    await expect(s.main(["/workspace/ok.py"])).rejects.toBe(tampered);
    expect(s.startedWith).toEqual([]);
    expect(s.stdio.take()).toEqual({ stdout: "", stderr: "" });
  });
});

describe("a command that runs", () => {
  it("starts Pyodide from the release's files with the process environment, then runs the program and returns its status", async () => {
    await writeFile(join(root, "workspace/program.py"), "import os, sys\nprint('ran', sys.argv, os.getpid(), os.getuid(), os.getgid(), os.getcwd(), os.environ['HOME'], os.environ.get('PYTHONPATH'))\nsys.exit(5)\n");
    const s = setup();
    expect(await s.main(["/workspace/program.py", "x", "y"], { env: { PATH: "/usr/bin", PYTHONPATH: "/vm", HOME: "/home/user" } })).toBe(5);
    expect(s.stdio.take()).toEqual({ stdout: "ran ['/workspace/program.py', 'x', 'y'] 777 1000 100 /workspace /home/user None\n", stderr: "" });
    expect(s.startedWith).toHaveLength(1);
    expect(s.startedWith[0]?.env).toEqual({ MPLBACKEND: "Agg", PATH: "/usr/bin", HOME: "/home/user" });
    expect([...s.artifactsRead].sort()).toEqual(["pyodide-lock.json", "pyodide.asm.wasm", "python_stdlib.zip"]);
    await s.close();
  });

  it("runs the text after -c under the name it was started by, which also names sys.executable and sys.orig_argv", async () => {
    const s = setup();
    expect(await s.main(["-c", "import sys\nprint(sys.argv, sys.orig_argv, sys.executable, repr(sys.path[0]))", "a"], { invocation: PYTHON })).toBe(0);
    expect(s.stdio.take()).toEqual({ stdout: "['-c', 'a'] ['python', '-c', 'import sys\\nprint(sys.argv, sys.orig_argv, sys.executable, repr(sys.path[0]))', 'a'] /usr/local/bin/python ''\n", stderr: "" });
    await s.close();
  });

  it("reads a program piped to standard input to its end, then runs it with nothing left to read, also for the application", async () => {
    const s = setup();
    expect(await s.main(["-", "one"], { invocation: APPLICATION, stdin: "import sys\nprint(sys.argv, __file__, repr(sys.stdin.read()), repr(sys.executable), sys.orig_argv)\n" })).toBe(0);
    // An application start has no path, so sys.executable is empty, as CPython reports an executable it cannot find.
    expect(s.stdio.take()).toEqual({ stdout: "['-', 'one'] <stdin> '' '' ['pyodide', '-', 'one']\n", stderr: "" });
    await s.close();
  });

  it("sees the VM's /tmp and home directory, and runs from /tmp", async () => {
    await writeFile(join(root, "home/.settings"), "from home");
    const s = setup();
    expect(await s.main(["-c", "import os\nopen('made-in-tmp.txt', 'w').write('tmp')\nopen(os.path.expanduser('~/made-in-home.txt'), 'w').write('home')\nprint(os.getcwd(), open('/home/user/.settings').read())"], { cwd: "/tmp" })).toBe(0);
    expect(s.stdio.take()).toEqual({ stdout: "/tmp from home\n", stderr: "" });
    expect(await readFile(join(root, "tmp/made-in-tmp.txt"), "utf8")).toBe("tmp");
    expect(await readFile(join(root, "home/made-in-home.txt"), "utf8")).toBe("home");
    await s.close();
  });

  it("resolves a relative program against the working directory and starts Python there", async () => {
    await mkdir(join(root, "workspace/project"));
    await writeFile(join(root, "workspace/project/tool.py"), "import os, sys\nprint(sys.argv[0], __file__, os.getcwd(), sys.path[0])\n");
    const s = setup();
    expect(await s.main(["tool.py"], { cwd: "/workspace/project" })).toBe(0);
    expect(s.stdio.take().stdout).toBe("tool.py /workspace/project/tool.py /workspace/project /workspace/project\n");
    await s.close();
  });

  it("prints the traceback of a failing program on standard error and returns 1", async () => {
    await writeFile(join(root, "workspace/failing.py"), "def f():\n    raise RuntimeError('broken')\nf()\n");
    const s = setup();
    expect(await s.main(["/workspace/failing.py"])).toBe(1);
    const { stdout, stderr } = s.stdio.take();
    expect(stdout).toBe("");
    expect(stderr).toContain("RuntimeError: broken");
    expect(stderr).toContain('File "/workspace/failing.py", line 3, in <module>');
    await s.close();
  });

  it("closes the sockets a program leaves open when the command ends", async () => {
    await writeFile(join(root, "workspace/leaky.py"), 'import oxidevm\nconnection = oxidevm.connect_unix("/workspace/_oxidevm/echo.sock")\nconnection.sendall(b"hi")\nprint(connection.recv(10))\n');
    const s = setup();
    expect(await s.main(["/workspace/leaky.py"])).toBe(0);
    expect(s.stdio.take().stdout).toBe("b'HI'\n");
    expect(s.sockets.closed).toEqual([]);
    await s.close();
    expect(s.sockets.closed).toHaveLength(1);
  });

  it("reports a failing workspace operation as a log line and an I/O error in Python, and carries on", async () => {
    await writeFile(join(root, "workspace/probe.py"), "import os\ntry:\n    os.stat('/workspace/data.txt')\nexcept OSError as error:\n    print('OSError', error.errno)\nprint(os.getpid())\n");
    const s = setup({ fs: files => ({ ...files, lstat: path => { if (path === "/workspace/data.txt") throw new Error("the host broke"); return files.lstat(path); } }) });
    expect(await s.main(["/workspace/probe.py"])).toBe(0);
    expect(s.stdio.take().stdout).toBe("OSError 29\n777\n");
    expect(s.logs).toEqual([JSON.stringify({ oxidevm: "log", module: "pyodide", event: "workspace-io", message: "the host broke" })]);
    await s.close();
  });
});
