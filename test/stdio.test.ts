import { LinuxError } from "@oxidevm/sdk/js-process";
import { kit } from "@oxidevm/sdk/wasm";
import type { PyodideInterface } from "pyodide";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncFiles } from "../src/host-types.ts";
import { attachStandardStreams } from "../src/stdio.ts";
import { fakeStdio } from "./support/fake-stdio.ts";
import { startPyodide } from "./support/pyodide-node.ts";

// How Python's standard streams meet the host's descriptors, checked in the real Pyodide: what a host failure becomes in
// Python, and what the host is asked for.

let py: PyodideInterface;
const stdio = fakeStdio();
const behaviour: { read?: SyncFiles["read"]; writeAll?: SyncFiles["writeAll"] } = {};
const asked: number[] = [];

beforeAll(async () => {
  py = await startPyodide();
  attachStandardStreams(py, {
    read: (fd, count) => { asked.push(count); return (behaviour.read ?? stdio.files.read)(fd, count); },
    writeAll: (fd, bytes) => { (behaviour.writeAll ?? stdio.files.writeAll)(fd, bytes); },
  }, stdio.streams, kit.errno);
});
afterEach(() => { delete behaviour.read; delete behaviour.writeAll; stdio.take(); });

function evaluate(code: string): unknown {
  const value: unknown = py.runPython(code);
  return value;
}

describe("standard output and error", () => {
  it("write to the descriptors, and each write has all the bytes of what was printed", () => {
    py.runPython('import sys\nprint("héllo")\nprint("oops", file=sys.stderr)\nsys.stdout.flush()\nsys.stderr.flush()');
    expect(stdio.take()).toEqual({ stdout: "héllo\n", stderr: "oops\n" });
  });

  it("reach Python as the OSError the host failure is, with the errno the kit can translate", () => {
    const attempt = 'import errno\ndef attempt():\n    try:\n        print("x", flush=True)\n    except OSError as error:\n        return type(error).__name__ + " " + errno.errorcode[error.errno]\n    return "written"\nattempt()';
    behaviour.writeAll = () => { throw new LinuxError(13); };
    expect(evaluate(attempt)).toBe("PermissionError EACCES");
    behaviour.writeAll = () => { throw new LinuxError(2); };
    expect(evaluate(attempt)).toBe("FileNotFoundError ENOENT");
    // A closed output is a BrokenPipeError, as it is for a native Python (the kit maps EPIPE).
    behaviour.writeAll = () => { throw new LinuxError(32); };
    expect(evaluate(attempt)).toBe("BrokenPipeError EPIPE");
    // An errno with no Emscripten counterpart still becomes an I/O error rather than a wrong name.
    behaviour.writeAll = () => { throw new LinuxError(133); };
    expect(evaluate(attempt)).toBe("OSError EIO");
    delete behaviour.writeAll;
    expect(evaluate(attempt)).toBe("written");
  });

  it("report a failure that is not an errno as an I/O error and keep the interpreter alive", () => {
    // Pyodide logs such a failure to the console before it turns it into EIO.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    behaviour.writeAll = () => { throw new Error("transport failed"); };
    expect(evaluate('import errno\ndef attempt():\n    try:\n        print("x", flush=True)\n    except OSError as error:\n        return errno.errorcode[error.errno]\nattempt()')).toBe("EIO");
    delete behaviour.writeAll;
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    py.runPython('print("alive")');
    expect(stdio.take().stdout).toContain("alive");
  });
});

describe("standard input", () => {
  it("asks the host for no more than the buffer Python lent, and none when the buffer is empty", () => {
    stdio.feed("abcdef\n");
    asked.length = 0;
    expect(evaluate("import sys\nsys.stdin.readline()")).toBe("abcdef\n");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(count => count > 0)).toBe(true);
  });

  it("never lets a host that returns too much overflow Python's buffer", () => {
    behaviour.read = (_fd, count) => new Uint8Array(count + 100).fill(120);
    expect(evaluate("import sys\nlen(sys.stdin.read(5))")).toBe(5);
  });

  it("reaches Python as the OSError the host failure is (read unbuffered, so that earlier input cannot answer instead)", () => {
    const attempt = 'import errno, sys\ndef attempt():\n    try:\n        sys.stdin.buffer.raw.read(1)\n    except OSError as error:\n        return type(error).__name__ + " " + errno.errorcode[error.errno]\n    return "read"\nattempt()';
    behaviour.read = () => { throw new LinuxError(13); };
    expect(evaluate(attempt)).toBe("PermissionError EACCES");
    behaviour.read = () => { throw new LinuxError(5); };
    expect(evaluate(attempt)).toBe("OSError EIO");
  });
});

describe("terminals", () => {
  // Each case attaches the streams again, as the command does once per process, then asks Python what it sees.
  const ask = 'import json, os, shutil, sys\ndef size(fd):\n    try:\n        return list(os.get_terminal_size(fd))\n    except OSError as error:\n        return error.__class__.__name__\njson.dumps({"isatty": [sys.stdin.isatty(), sys.stdout.isatty(), sys.stderr.isatty()], "os": [os.isatty(0), os.isatty(1), os.isatty(2)], "size": [size(0), size(1), size(2)], "shutil": list(shutil.get_terminal_size((1, 1)))})';
  const reattach = (terminals: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean }, size: { readonly columns: number; readonly rows: number } | null): void => {
    attachStandardStreams(py, stdio.files, stdio.streams, kit.errno, terminals, size);
  };
  afterEach(() => { reattach({ stdin: false, stdout: false, stderr: false }, null); });

  it("are what the process has: a terminal on each descriptor the caller's terminal is on, with its size", () => {
    reattach({ stdin: true, stdout: true, stderr: false }, { columns: 132, rows: 43 });
    expect(JSON.parse(String(evaluate(ask)))).toEqual({ isatty: [true, true, false], os: [true, true, false], size: [[80, 24], [132, 43], "OSError"], shutil: [132, 43] });
  });

  it("are none for pipes and files, which have no size, so that programs do not colour or page their output", () => {
    reattach({ stdin: false, stdout: false, stderr: false }, { columns: 132, rows: 43 });
    expect(JSON.parse(String(evaluate(ask)))).toEqual({ isatty: [false, false, false], os: [false, false, false], size: ["OSError", "OSError", "OSError"], shutil: [1, 1] });
  });

  it("have the usual 80 by 24 when the process has a terminal of unknown size", () => {
    reattach({ stdin: false, stdout: true, stderr: true }, null);
    expect(JSON.parse(String(evaluate(ask)))).toMatchObject({ isatty: [false, true, true], size: ["OSError", [80, 24], [80, 24]] });
  });
});
