import { describe, expect, it } from "vitest";
import { invocationOf, MAX_SCRIPT_BYTES, pythonEnvironment, readScript, workingDirectory } from "../src/script.ts";

describe("invocationOf", () => {
  it("takes the first argument as the program and the rest as its arguments", () => {
    expect(invocationOf(["/workspace/run.py", "a", "--b"], "/workspace")).toEqual({ script: "/workspace/run.py", path: "/workspace/run.py", arguments: ["a", "--b"] });
  });

  it("resolves a relative program against the working directory but keeps it as typed for sys.argv", () => {
    expect(invocationOf(["tools/run.py"], "/workspace/project")).toEqual({ script: "tools/run.py", path: "/workspace/project/tools/run.py", arguments: [] });
    expect(invocationOf(["run.py"], "/")).toMatchObject({ path: "//run.py" });
  });

  it("is nothing when no program is named", () => {
    expect(invocationOf([], "/workspace")).toBeUndefined();
    expect(invocationOf([""], "/workspace")).toBeUndefined();
    expect(invocationOf(["", "x"], "/workspace")).toBeUndefined();
  });
});

describe("workingDirectory", () => {
  it("keeps the workspace and everything under it", () => {
    expect(workingDirectory("/workspace")).toBe("/workspace");
    expect(workingDirectory("/workspace/project/src")).toBe("/workspace/project/src");
  });

  it("falls back to the workspace for anything else, including look-alikes", () => {
    for (const cwd of ["/", "/tmp", "/home/user", "/workspace2", "/workspacefoo/bar", "", "workspace"]) expect(workingDirectory(cwd), cwd).toBe("/workspace");
  });
});

describe("pythonEnvironment", () => {
  it("passes the process environment on, puts HOME in the workspace, and defaults Matplotlib to files", () => {
    expect(pythonEnvironment({ PATH: "/usr/bin", HOME: "/home/user", LANG: "C.UTF-8" })).toEqual({ MPLBACKEND: "Agg", PATH: "/usr/bin", HOME: "/workspace", LANG: "C.UTF-8" });
  });

  it("lets the process choose another Matplotlib backend", () => {
    expect(pythonEnvironment({ MPLBACKEND: "svg" })).toMatchObject({ MPLBACKEND: "svg" });
  });

  it("leaves out the settings of the VM's own Python", () => {
    const environment = pythonEnvironment({ PYTHONHOME: "/usr", PYTHONPATH: "/x", PYTHONSTARTUP: "/s", PYTHONUNBUFFERED: "1", PYTHON_FOO: "1", NOTPYTHON: "kept", PY: "kept" });
    expect(Object.keys(environment).sort()).toEqual(["HOME", "MPLBACKEND", "NOTPYTHON", "PY"]);
  });

  it("does not change what it was given", () => {
    const given = { PATH: "/bin" };
    pythonEnvironment(given);
    expect(given).toEqual({ PATH: "/bin" });
  });
});

describe("readScript", () => {
  const invocation = { script: "run.py", path: "/workspace/run.py", arguments: [] };
  const errnoOf = (error: unknown): number | undefined => {
    const errno: unknown = error instanceof Error ? Reflect.get(error, "errno") : undefined;
    return typeof errno === "number" ? errno : undefined;
  };
  const throwValue = (value: unknown): never => { throw value; };
  const failing = (errno: number): { readFile: () => never } => ({ readFile: () => { throw Object.assign(new Error("host error"), { errno }); } });

  it("reads UTF-8 text, up to 16 MiB", () => {
    const requested: (number | undefined)[] = [];
    const files = { readFile: (_path: string, maxBytes?: number) => { requested.push(maxBytes); return new TextEncoder().encode("print('héllo')\n"); } };
    expect(readScript(files, errnoOf, invocation)).toEqual({ kind: "source", text: "print('héllo')\n" });
    expect(requested).toEqual([MAX_SCRIPT_BYTES]);
    expect(MAX_SCRIPT_BYTES).toBe(16 * 1024 ** 2);
  });

  it("words a missing or unreadable file the way Python does", () => {
    expect(readScript(failing(2), errnoOf, invocation)).toEqual({ kind: "unreadable", message: "pyodide: can't open file '/workspace/run.py': [Errno 2] No such file or directory" });
    expect(readScript(failing(13), errnoOf, invocation)).toMatchObject({ message: "pyodide: can't open file '/workspace/run.py': [Errno 13] Permission denied" });
    expect(readScript(failing(21), errnoOf, invocation)).toMatchObject({ message: "pyodide: can't open file '/workspace/run.py': [Errno 21] Is a directory" });
  });

  it("gives the host's own message for an error it has no wording for", () => {
    expect(readScript(failing(999), errnoOf, invocation)).toMatchObject({ message: "pyodide: can't open file '/workspace/run.py': host error" });
    expect(readScript({ readFile: () => { throw new Error("plain"); } }, errnoOf, invocation)).toMatchObject({ message: "pyodide: can't open file '/workspace/run.py': plain" });
    expect(readScript({ readFile: () => throwValue("not an error") }, errnoOf, invocation)).toMatchObject({ message: "pyodide: can't open file '/workspace/run.py': unreadable" });
  });

  it("refuses text that is not valid UTF-8", () => {
    expect(readScript({ readFile: () => Uint8Array.of(0x70, 0xff, 0xfe) }, errnoOf, invocation)).toEqual({ kind: "unreadable", message: "pyodide: /workspace/run.py is not valid UTF-8 text" });
  });

  it("drops a byte order mark, as Python does", () => {
    expect(readScript({ readFile: () => Uint8Array.of(0xef, 0xbb, 0xbf, 0x78) }, errnoOf, invocation)).toEqual({ kind: "source", text: "x" });
  });
});
