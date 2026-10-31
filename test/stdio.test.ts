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
    // A closed output is a BrokenPipeError, as it is for a native Python (the kit maps EPIPE since alpha 303).
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
