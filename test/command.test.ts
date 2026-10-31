import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommand } from "../src/command.ts";
import type { CommandHost } from "../src/host-types.ts";
import type { Engine, PyodideOptions } from "../src/python-loader.ts";
import { USAGE } from "../src/script.ts";
import type { ShippedFile } from "../src/shipped.ts";
import { processId } from "./support/brands.ts";
import { fakeProcess } from "./support/fake-process.ts";
import { echoUpperCase, fakeSockets } from "./support/fake-sockets.ts";
import { fakeStdio } from "./support/fake-stdio.ts";
import { nodeFiles } from "./support/node-files.ts";
import { startPyodide } from "./support/pyodide-node.ts";

// The command end to end in Node: the real Pyodide, started from node_modules instead of the virtual index (a Node
// loader cannot use one), against fakes of the VM's files, processes and sockets.

interface Setup {
  readonly host: CommandHost;
  readonly main: (args: readonly string[], cwd?: string, env?: Readonly<Record<string, string>>) => Promise<number>;
  readonly close: () => Promise<void>;
  readonly failures: string[];
  readonly logs: string[];
  readonly artifactsRead: ShippedFile[];
  readonly startedWith: PyodideOptions[];
  readonly sockets: ReturnType<typeof fakeSockets>;
  readonly stdio: ReturnType<typeof fakeStdio>;
  readonly root: string;
  readonly files: ReturnType<typeof nodeFiles>;
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pyodide-command-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(options: { readonly bytes?: CommandHost["artifacts"]["bytes"]; readonly fs?: (files: ReturnType<typeof nodeFiles>["files"]) => CommandHost["fs"] } = {}): Setup {
  const stdio = fakeStdio();
  const files = nodeFiles(root, stdio.files);
  const children = fakeProcess(() => ({}));
  const sockets = fakeSockets();
  sockets.listen("unix:/workspace/_oxidevm/echo.sock", echoUpperCase());
  const failures: string[] = [], logs: string[] = [], artifactsRead: ShippedFile[] = [], startedWith: PyodideOptions[] = [];
  const lifetime = new AbortController();
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
    log: line => { logs.push(line); },
    fail: (status, message) => { failures.push(`${String(status)}: ${message}`); return status; },
  };
  const engine: Engine = {
    scope: { fetch: () => Promise.reject(new Error("no network in tests")) },
    createPyodideModule: () => Promise.reject(new Error("not used: Node starts Pyodide from node_modules")),
    loadPyodide: options => { startedWith.push(options); return startPyodide(options.env); },
  };
  const command = createCommand(host, engine);
  return {
    host, failures, logs, artifactsRead, startedWith, sockets, stdio, root, files,
    main: (args, cwd = "/workspace", env = { PATH: "/usr/bin" }) => Promise.resolve(command.main({ args, env, cwd, stdin: stdio.streams.stdin, stdout: stdio.streams.stdout, stderr: stdio.streams.stderr })),
    close: async () => { await command.close?.(); lifetime.abort(); },
  };
}

describe("a command that cannot start", () => {
  it("answers a missing program with the usage text and status 2, without loading anything", async () => {
    const s = setup();
    expect(await s.main([])).toBe(2);
    expect(await s.main([""])).toBe(2);
    expect(s.failures).toEqual([`2: ${USAGE}`, `2: ${USAGE}`]);
    expect(s.startedWith).toEqual([]);
    expect(s.artifactsRead).toEqual([]);
  });

  it("answers a program that cannot be opened with status 2 and Python's wording", async () => {
    const s = setup();
    expect(await s.main(["/workspace/missing.py"])).toBe(2);
    expect(s.failures).toEqual(["2: pyodide: can't open file '/workspace/missing.py': [Errno 2] No such file or directory"]);
    expect(s.startedWith).toEqual([]);
  });

  it("answers a program that is not text with status 1", async () => {
    await writeFile(join(root, "binary.py"), Uint8Array.of(0x70, 0xff, 0xfe));
    const s = setup();
    expect(await s.main(["/workspace/binary.py"])).toBe(1);
    expect(s.failures).toEqual(["1: pyodide: /workspace/binary.py is not valid UTF-8 text"]);
  });

  it("lets a file that does not match its pin stop it, as the runner's integrity failure, not as a status", async () => {
    await writeFile(join(root, "ok.py"), "print('never runs')");
    const tampered = new Error("pyodide.asm.wasm does not match its sha256 pin");
    const s = setup({ bytes: name => (name === "pyodide.asm.wasm" ? Promise.reject(tampered) : Promise.resolve(new TextEncoder().encode(name === "pyodide-lock.json" ? '{"packages":{}}' : "x"))) });
    await expect(s.main(["/workspace/ok.py"])).rejects.toBe(tampered);
    expect(s.startedWith).toEqual([]);
    expect(s.stdio.take()).toEqual({ stdout: "", stderr: "" });
  });
});

describe("a command that runs", () => {
  it("starts Pyodide from the release's files with the process environment, then runs the program and returns its status", async () => {
    await writeFile(join(root, "program.py"), "import os, sys\nprint('ran', sys.argv[1:], os.getpid(), os.getuid(), os.getgid(), os.getcwd(), os.environ['HOME'], os.environ.get('PYTHONPATH'))\nsys.exit(5)\n");
    const s = setup();
    expect(await s.main(["/workspace/program.py", "x", "y"], "/workspace", { PATH: "/usr/bin", PYTHONPATH: "/vm" })).toBe(5);
    expect(s.stdio.take()).toEqual({ stdout: "ran ['x', 'y'] 777 1000 100 /workspace /workspace None\n", stderr: "" });
    expect(s.startedWith).toHaveLength(1);
    expect(s.startedWith[0]?.env).toEqual({ MPLBACKEND: "Agg", PATH: "/usr/bin", HOME: "/workspace" });
    expect([...s.artifactsRead].sort()).toEqual(["pyodide-lock.json", "pyodide.asm.wasm", "python_stdlib.zip"]);
    await s.close();
  });

  it("resolves a relative program against the working directory and starts Python there", async () => {
    await mkdir(join(root, "project"));
    await writeFile(join(root, "project/tool.py"), "import os, sys\nprint(sys.argv[0], __file__, os.getcwd())\n");
    const s = setup();
    expect(await s.main(["tool.py"], "/workspace/project")).toBe(0);
    expect(s.stdio.take().stdout).toBe("tool.py /workspace/project/tool.py /workspace/project\n");
    await s.close();
  });

  it("starts Python in the workspace when the process was started elsewhere", async () => {
    await writeFile(join(root, "where.py"), "import os\nprint(os.getcwd())\n");
    const s = setup();
    expect(await s.main(["/workspace/where.py"], "/")).toBe(0);
    expect(s.stdio.take().stdout).toBe("/workspace\n");
    await s.close();
  });

  it("prints the traceback of a failing program on standard error and returns 1", async () => {
    await writeFile(join(root, "failing.py"), "def f():\n    raise RuntimeError('broken')\nf()\n");
    const s = setup();
    expect(await s.main(["/workspace/failing.py"])).toBe(1);
    const { stdout, stderr } = s.stdio.take();
    expect(stdout).toBe("");
    expect(stderr).toContain("RuntimeError: broken");
    expect(stderr).toContain('File "/workspace/failing.py", line 3, in <module>');
    await s.close();
  });

  it("closes the sockets a program leaves open when the command ends", async () => {
    await writeFile(join(root, "leaky.py"), 'import oxidevm\nconnection = oxidevm.connect_unix("/workspace/_oxidevm/echo.sock")\nconnection.sendall(b"hi")\nprint(connection.recv(10))\n');
    const s = setup();
    expect(await s.main(["/workspace/leaky.py"])).toBe(0);
    expect(s.stdio.take().stdout).toBe("b'HI'\n");
    expect(s.sockets.closed).toEqual([]);
    await s.close();
    expect(s.sockets.closed).toHaveLength(1);
  });

  it("reports a failing workspace operation as a log line and an I/O error in Python, and carries on", async () => {
    await writeFile(join(root, "probe.py"), "import os\ntry:\n    os.stat('/workspace/data.txt')\nexcept OSError as error:\n    print('OSError', error.errno)\nprint(os.getpid())\n");
    const s = setup({ fs: files => ({ ...files, lstat: path => { if (path === "/workspace/data.txt") throw new Error("the host broke"); return files.lstat(path); } }) });
    expect(await s.main(["/workspace/probe.py"])).toBe(0);
    expect(s.stdio.take().stdout).toBe("OSError 29\n777\n");
    expect(s.logs).toEqual([JSON.stringify({ oxidevm: "log", module: "pyodide", event: "workspace-io", message: "the host broke" })]);
    await s.close();
  });
});
