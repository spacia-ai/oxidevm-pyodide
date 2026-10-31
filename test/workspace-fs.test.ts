import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import type { PyodideInterface } from "pyodide";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncFiles } from "../src/host-types.ts";
import { MAX_TRANSFER_BYTES, mountWorkspace } from "../src/workspace-fs.ts";
import { field } from "./support/decode.ts";
import { errno, nodeFiles } from "./support/node-files.ts";
import type { NodeFiles } from "./support/node-files.ts";
import { startPyodide } from "./support/pyodide-node.ts";

// These tests run the bridge inside the real Pyodide, against a directory of this machine that stands in for the VM's
// /workspace. Python does ordinary file work; the assertions look at the directory (what Linux would see) and at what
// Python reports, including the errno values, which Emscripten numbers differently from Linux.

let root: string;
let host: NodeFiles;
let py: PyodideInterface;
/** What the bridge reported as an unexpected host failure. */
const reported: unknown[] = [];
/** The sizes of the writes that reached the host. */
const writeSizes: number[] = [];
/** Operations that fail or answer differently, switched on for one test. */
const faults: { lstat?: (path: string) => ReturnType<SyncFiles["lstat"]>; read?: () => never } = {};

const PRELUDE = `import errno, hashlib, json, os
def failure(operation):
    try:
        operation()
    except OSError as error:
        return {"class": type(error).__name__, "errno": error.errno, "name": errno.errorcode.get(error.errno)}
    return None
`;

/** Runs Python whose last expression is a JSON string, and returns what that decodes to. */
function python(code: string): unknown {
  const text: unknown = py.runPython(`${PRELUDE}${code}`);
  if (typeof text !== "string") throw new Error("the Python code must end with json.dumps(...)");
  const value: unknown = JSON.parse(text);
  return value;
}

async function directory(name: string): Promise<string> {
  await mkdir(join(root, name), { recursive: true });
  return `/workspace/${name}`;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pyodide-fs-"));
  host = nodeFiles(root);
  const files: SyncFiles = {
    ...host.files,
    lstat: path => (faults.lstat === undefined ? host.files.lstat(path) : faults.lstat(typeof path === "string" ? path : "")),
    read: (fd, count) => { if (faults.read !== undefined) faults.read(); return host.files.read(fd, count); },
    write: (fd, bytes) => { writeSizes.push(bytes.length); return host.files.write(fd, bytes); },
  };
  py = await startPyodide();
  mountWorkspace(py.FS, files, errno, error => reported.push(error));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("files both ways", () => {
  it("reads what Linux wrote, writes what Linux then reads, and sees later changes by Linux", async () => {
    const dir = await directory("both-ways");
    await writeFile(join(root, "both-ways/native.txt"), "from Linux");
    const seen = python(`
with open("${dir}/native.txt") as file:
    first = file.read()
with open("${dir}/python.txt", "w") as file:
    file.write("from Python")
with open("${dir}/python.txt", "r+") as file:
    file.seek(5)
    file.write("WASM")
json.dumps({"first": first})
`);
    expect(seen).toEqual({ first: "from Linux" });
    expect(await readFile(join(root, "both-ways/python.txt"), "utf8")).toBe("from WASMon");
    await writeFile(join(root, "both-ways/native.txt"), "changed by Linux");
    expect(python(`json.dumps(open("${dir}/native.txt").read())`)).toBe("changed by Linux");
  });

  it("creates directories, renames files into them and removes them again", async () => {
    const dir = await directory("tree");
    python(`
os.mkdir("${dir}/folder")
open("${dir}/a.txt", "w").write("moved")
os.rename("${dir}/a.txt", "${dir}/folder/result.txt")
json.dumps(0)
`);
    expect(await readFile(join(root, "tree/folder/result.txt"), "utf8")).toBe("moved");
    expect(python(`json.dumps({"folder": sorted(os.listdir("${dir}/folder")), "top": sorted(os.listdir("${dir}"))})`)).toEqual({ folder: ["result.txt"], top: ["folder"] });
    python(`
os.unlink("${dir}/folder/result.txt")
os.rmdir("${dir}/folder")
json.dumps(0)
`);
    expect(await readdir(join(root, "tree"))).toEqual([]);
  });

  it("keeps writing to a file after it was renamed, as Linux does", async () => {
    const dir = await directory("renamed-open");
    python(`
file = open("${dir}/before.txt", "w")
file.write("one ")
file.flush()
os.rename("${dir}/before.txt", "${dir}/after.txt")
file.write("two")
file.close()
json.dumps(0)
`);
    expect(await readFile(join(root, "renamed-open/after.txt"), "utf8")).toBe("one two");
  });

  it("lists a directory without the . and .. entries the host adds, including files Linux created", async () => {
    const dir = await directory("listing");
    await writeFile(join(root, "listing/native-a"), "");
    await mkdir(join(root, "listing/native-dir"));
    expect(python(`json.dumps(sorted(os.listdir("${dir}")))`)).toEqual(["native-a", "native-dir"]);
    expect(python(`json.dumps(sorted(entry.name for entry in os.scandir("${dir}") if entry.is_dir()))`)).toEqual(["native-dir"]);
  });

  it("reports size, kind, permissions and times as Linux has them", async () => {
    const dir = await directory("stat");
    await writeFile(join(root, "stat/file.bin"), Buffer.alloc(1234, 7), { mode: 0o640 });
    const real = await stat(join(root, "stat/file.bin"));
    const seen = python(`
info = os.stat("${dir}/file.bin")
json.dumps({"size": info.st_size, "mode": info.st_mode & 0o7777, "file": os.path.isfile("${dir}/file.bin"), "dir": os.path.isdir("${dir}"), "mtime": info.st_mtime, "blocks": info.st_blocks})
`);
    expect(seen).toMatchObject({ size: 1234, mode: real.mode & 0o7777, file: true, dir: true, blocks: Math.ceil(1234 / 512) });
    const mtime = field(seen, "mtime");
    expect(typeof mtime === "number" && Math.abs(mtime - real.mtimeMs / 1000) < 0.002).toBe(true);
  });
});

describe("positions", () => {
  it("seeks from the start, the current position and the end when reading", async () => {
    const dir = await directory("seek-read");
    await writeFile(join(root, "seek-read/letters"), "abcdefghij");
    expect(python(`
with open("${dir}/letters", "rb") as file:
    file.seek(3)
    a = file.read(2)
    file.seek(2, 1)
    b = file.read(1)
    file.seek(-3, 2)
    c = file.read()
    d = file.tell()
    file.seek(0)
    e = file.read(1)
json.dumps([a.decode(), b.decode(), c.decode(), d, e.decode()])
`)).toEqual(["de", "h", "hij", 10, "a"]);
  });

  it("writes at a position, appends, and keeps the bytes around them", async () => {
    const dir = await directory("seek-write");
    await writeFile(join(root, "seek-write/letters"), "abcdefghij");
    python(`
with open("${dir}/letters", "r+b") as file:
    file.seek(4)
    file.write(b"WXYZ")
    file.seek(-2, 1)
    file.write(b"__")
with open("${dir}/letters", "ab") as file:
    file.write(b"!")
json.dumps(0)
`);
    expect(await readFile(join(root, "seek-write/letters"), "utf8")).toBe("abcdWX__ij!");
  });

  it("reads and writes at explicit positions without disturbing the stream position", async () => {
    const dir = await directory("pread");
    await writeFile(join(root, "pread/letters"), "abcdefghij");
    expect(python(`
fd = os.open("${dir}/letters", os.O_RDWR)
first = os.pread(fd, 3, 5)
os.pwrite(fd, b"ZZ", 1)
after = os.read(fd, 4)
os.close(fd)
json.dumps([first.decode(), after.decode()])
`)).toEqual(["fgh", "aZZd"]);
  });

  it("refuses a position before the start of the file with EINVAL, whichever way it is reached", async () => {
    const dir = await directory("seek-negative");
    await writeFile(join(root, "seek-negative/letters"), "abc");
    expect(python(`
fd = os.open("${dir}/letters", os.O_RDONLY)
result = {
    "start": failure(lambda: os.lseek(fd, -5, os.SEEK_SET)),
    "current": failure(lambda: os.lseek(fd, -5, os.SEEK_CUR)),
    "end": failure(lambda: os.lseek(fd, -5, os.SEEK_END)),
    "unchanged": os.lseek(fd, 0, os.SEEK_CUR),
}
os.close(fd)
json.dumps(result)
`)).toMatchObject({ start: { name: "EINVAL" }, current: { name: "EINVAL" }, end: { name: "EINVAL" }, unchanged: 0 });
  });
});

describe("large files", () => {
  it("writes 40 MiB across the transfer limit and Linux reads every byte", async () => {
    const dir = await directory("large-write");
    const size = 40 * 1024 ** 2;
    expect(size).toBeGreaterThan(2 * MAX_TRANSFER_BYTES);
    const seen = python(`
data = os.urandom(${String(size)})
with open("${dir}/big.bin", "wb") as file:
    written = file.write(data)
json.dumps({"written": written, "sha": hashlib.sha256(data).hexdigest()})
`);
    const stored = await readFile(join(root, "large-write/big.bin"));
    expect(stored.length).toBe(size);
    expect(seen).toEqual({ written: size, sha: createHash("sha256").update(stored).digest("hex") });
  });

  it("reads a 40 MiB file Linux wrote, in full and in order", async () => {
    const dir = await directory("large-read");
    const data = randomBytes(40 * 1024 ** 2);
    await writeFile(join(root, "large-read/big.bin"), data);
    expect(python(`
with open("${dir}/big.bin", "rb") as file:
    content = file.read()
json.dumps({"length": len(content), "sha": hashlib.sha256(content).hexdigest()})
`)).toEqual({ length: data.length, sha: createHash("sha256").update(data).digest("hex") });
  });

  it("hands the host at most the transfer limit in one write, and says how much it took", async () => {
    const dir = await directory("write-limit");
    writeSizes.length = 0;
    expect(python(`
fd = os.open("${dir}/data", os.O_CREAT | os.O_WRONLY, 0o600)
written = os.write(fd, bytes(${String(MAX_TRANSFER_BYTES + 5)}))
rest = os.write(fd, bytes(5))
os.close(fd)
json.dumps([written, rest])
`)).toEqual([MAX_TRANSFER_BYTES, 5]);
    expect(writeSizes).toEqual([MAX_TRANSFER_BYTES, 5]);
    expect((await stat(join(root, "write-limit/data"))).size).toBe(MAX_TRANSFER_BYTES + 5);
  });

  it("moves at most the transfer limit in one host call", async () => {
    const dir = await directory("limit");
    await writeFile(join(root, "limit/data"), Buffer.alloc(MAX_TRANSFER_BYTES + 5, 1));
    // Python's raw read asks for the whole file at once; the bridge answers with one chunk and the rest follows.
    expect(python(`
fd = os.open("${dir}/data", os.O_RDONLY)
first = os.read(fd, ${String(MAX_TRANSFER_BYTES + 5)})
second = os.read(fd, ${String(MAX_TRANSFER_BYTES + 5)})
os.close(fd)
json.dumps([len(first), len(second)])
`)).toEqual([MAX_TRANSFER_BYTES, 5]);
  });
});

describe("permissions", () => {
  it("creates a file with the requested permission bits", async () => {
    const dir = await directory("modes");
    python(`
os.close(os.open("${dir}/private.txt", os.O_CREAT | os.O_WRONLY, 0o600))
open("${dir}/plain.txt", "w").close()
os.mkdir("${dir}/sub", 0o700)
json.dumps(0)
`);
    // What Linux makes of the same request is the oracle, so the machine's umask does not matter.
    await writeFile(join(root, "modes/native-file"), "", { mode: 0o666 });
    await mkdir(join(root, "modes/native-dir"), { mode: 0o700 });
    expect((await stat(join(root, "modes/private.txt"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "modes/plain.txt"))).mode & 0o777).toBe((await stat(join(root, "modes/native-file"))).mode & 0o777);
    expect((await stat(join(root, "modes/sub"))).mode & 0o777).toBe((await stat(join(root, "modes/native-dir"))).mode & 0o777);
  });

  it("changes the mode of an existing file", async () => {
    const dir = await directory("chmod");
    await writeFile(join(root, "chmod/file"), "x", { mode: 0o644 });
    expect(python(`
os.chmod("${dir}/file", 0o600)
json.dumps(os.stat("${dir}/file").st_mode & 0o7777)
`)).toBe(0o600);
    expect((await stat(join(root, "chmod/file"))).mode & 0o7777).toBe(0o600);
  });

  it("copies a file with its permission bits, which needs chmod to work", async () => {
    const dir = await directory("shutil");
    await writeFile(join(root, "shutil/source"), "payload", { mode: 0o640 });
    python(`
import shutil
shutil.copy("${dir}/source", "${dir}/target")
json.dumps(0)
`);
    expect(await readFile(join(root, "shutil/target"), "utf8")).toBe("payload");
    expect((await stat(join(root, "shutil/target"))).mode & 0o777).toBe(0o640);
  });
});

describe("truncation", () => {
  it("empties a file that is opened for writing", async () => {
    const dir = await directory("truncate-open");
    await writeFile(join(root, "truncate-open/file"), "long content");
    python(`
with open("${dir}/file", "w") as file:
    file.write("new")
json.dumps(0)
`);
    expect(await readFile(join(root, "truncate-open/file"), "utf8")).toBe("new");
  });

  it("shortens and lengthens a file by name and by stream", async () => {
    const dir = await directory("truncate-size");
    await writeFile(join(root, "truncate-size/file"), "0123456789");
    python(`
os.truncate("${dir}/file", 4)
json.dumps(0)
`);
    expect(await readFile(join(root, "truncate-size/file"), "utf8")).toBe("0123");
    python(`
with open("${dir}/file", "r+") as file:
    file.truncate(8)
json.dumps(0)
`);
    expect([...(await readFile(join(root, "truncate-size/file")))]).toEqual([48, 49, 50, 51, 0, 0, 0, 0]);
  });
});

describe("symbolic links", () => {
  it("creates and reads links, and follows them to the file", async () => {
    const dir = await directory("links");
    await writeFile(join(root, "links/target.txt"), "through the link");
    await symlink("target.txt", join(root, "links/existing"));
    const seen = python(`
os.symlink("target.txt", "${dir}/made")
json.dumps({
    "text": open("${dir}/existing").read(),
    "target": os.readlink("${dir}/made"),
    "islink": [os.path.islink("${dir}/made"), os.path.islink("${dir}/target.txt")],
    "lstat_link": os.path.stat.S_ISLNK(os.lstat("${dir}/made").st_mode),
    "stat_file": os.path.stat.S_ISREG(os.stat("${dir}/made").st_mode),
})
`);
    expect(seen).toEqual({ text: "through the link", target: "target.txt", islink: [true, false], lstat_link: true, stat_file: true });
    expect(await readlink(join(root, "links/made"))).toBe("target.txt");
    expect((await lstat(join(root, "links/made"))).isSymbolicLink()).toBe(true);
  });
});

describe("special files", () => {
  it("lists and describes a directory that holds a Unix socket, so that Python can import from it", async () => {
    // Service sockets live beside the programs that use them, and `python script.py` puts the script's directory on sys.path.
    const dir = await directory("with-socket");
    await writeFile(join(root, "with-socket/helper_in_socket_dir.py"), "VALUE = 'imported from the directory with the socket'\n");
    const server = createServer();
    await new Promise<void>(resolve => { server.listen(join(root, "with-socket/service.sock"), resolve); });
    try {
      const seen = python(`
import stat, sys
sys.path.insert(0, "${dir}")
import helper_in_socket_dir
info = os.stat("${dir}/service.sock")
json.dumps({
    "listing": sorted(os.listdir("${dir}")),
    "imported": helper_in_socket_dir.VALUE,
    "is_socket": stat.S_ISSOCK(info.st_mode),
    "entry_is_file": [entry.name for entry in os.scandir("${dir}") if entry.is_file(follow_symlinks=False)],
    "open": failure(lambda: open("${dir}/service.sock")),
})
`);
      expect(seen).toMatchObject({ listing: ["helper_in_socket_dir.py", "service.sock"], imported: "imported from the directory with the socket", is_socket: true });
      expect(field(seen, "open")).not.toBeNull();
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
  });
});

describe("errors", () => {
  it("reports each host failure as the matching Python exception, with Python's own errno value", async () => {
    const dir = await directory("errors");
    await mkdir(join(root, "errors/full"));
    await writeFile(join(root, "errors/full/inside"), "");
    await writeFile(join(root, "errors/file"), "");
    const seen = python(`
json.dumps({
    "missing": failure(lambda: open("${dir}/missing")),
    "exists": failure(lambda: os.mkdir("${dir}/full")),
    "notempty": failure(lambda: os.rmdir("${dir}/full")),
    "unlink_missing": failure(lambda: os.unlink("${dir}/missing")),
    "rename_missing": failure(lambda: os.rename("${dir}/missing", "${dir}/other")),
    "unlink_directory": failure(lambda: os.unlink("${dir}/full")),
    "under_file": failure(lambda: open("${dir}/file/child", "w")),
})
`);
    expect(seen).toMatchObject({
      missing: { class: "FileNotFoundError", name: "ENOENT" },
      exists: { class: "FileExistsError", name: "EEXIST" },
      notempty: { name: "ENOTEMPTY" },
      unlink_missing: { class: "FileNotFoundError", name: "ENOENT" },
      rename_missing: { class: "FileNotFoundError", name: "ENOENT" },
      under_file: { class: "NotADirectoryError", name: "ENOTDIR" },
    });
    // POSIX allows either error for unlinking a directory.
    expect(["EISDIR", "EPERM"]).toContain(field(field(seen, "unlink_directory"), "name"));
  });

  it("turns an errno Emscripten has no number for into EIO", async () => {
    const dir = await directory("unmapped");
    await writeFile(join(root, "unmapped/file"), "");
    faults.lstat = () => { throw new LinuxError(4000); };
    try {
      expect(python(`json.dumps(failure(lambda: os.stat("${dir}/file")))`)).toMatchObject({ name: "EIO" });
    } finally {
      delete faults.lstat;
    }
  });

  it("refuses a file size that JavaScript cannot count with EOVERFLOW", async () => {
    const dir = await directory("overflow");
    await writeFile(join(root, "overflow/file"), "");
    faults.lstat = path => ({ ...host.files.lstat(path), size: 2n ** 60n });
    try {
      expect(python(`json.dumps(failure(lambda: os.stat("${dir}/file")))`)).toMatchObject({ name: "EOVERFLOW" });
    } finally {
      delete faults.lstat;
    }
  });

  it("reports an operation the host cannot do as not supported", async () => {
    const dir = await directory("unsupported");
    await writeFile(join(root, "unsupported/file"), "");
    expect(python(`json.dumps(failure(lambda: os.utime("${dir}/file", (1, 1))))`)).toMatchObject({ name: "ENOTSUP" });
    // Creating a special file is refused (Python has no os.mknod here, so this goes to Emscripten's file system directly),
    // although a directory may hold one that something else made.
    let refused: unknown;
    try {
      py.FS.mkdev(`${dir}/device`, 0o600, 0);
    } catch (error: unknown) {
      refused = field(error, "errno");
    }
    expect(refused).toBe(138);
    // A file is created through `open`, which supplies its real mode afterwards; creating one directly with a mode is refused.
    const create: unknown = Reflect.get(py.FS, "create");
    let refusedCreate: unknown;
    try {
      if (typeof create !== "function") throw new Error("Emscripten's FS.create is missing");
      Reflect.apply(create, py.FS, [`${dir}/direct`, 0o600]);
    } catch (error: unknown) {
      refusedCreate = field(error, "errno");
    }
    expect(refusedCreate).toBe(138);
    expect(await readdir(join(root, "unsupported"))).toEqual(["file"]);
  });

  it("keeps the interpreter alive when the host throws something that is not an errno", async () => {
    const dir = await directory("plain-error");
    await writeFile(join(root, "plain-error/file"), "data");
    faults.lstat = () => { throw new Error("host protocol failure"); };
    try {
      expect(python(`json.dumps(failure(lambda: os.stat("${dir}/file")))`)).toMatchObject({ name: "EIO" });
    } finally {
      delete faults.lstat;
    }
    // Pyodide would be unusable now if the exception had unwound through its frames.
    expect(python(`json.dumps(open("${dir}/file").read())`)).toBe("data");
    expect(reported.map(error => (error instanceof Error ? error.message : ""))).toEqual(["host protocol failure"]);
  });

  it("reports an unreadable stream as EIO and still closes it", async () => {
    const dir = await directory("read-failure");
    await writeFile(join(root, "read-failure/file"), "data");
    const before = host.openDescriptors();
    faults.read = () => { throw new LinuxError(5); };
    try {
      expect(python(`
file = open("${dir}/file", "rb", buffering=0)
result = failure(lambda: file.read(4))
file.close()
json.dumps(result)
`)).toMatchObject({ name: "EIO" });
    } finally {
      delete faults.read;
    }
    expect(host.openDescriptors()).toBe(before);
  });
});

describe("descriptors", () => {
  it("closes every descriptor it opened", async () => {
    const dir = await directory("leaks");
    await writeFile(join(root, "leaks/file"), "x");
    const before = host.openDescriptors();
    python(`
for index in range(20):
    with open("${dir}/file") as file:
        file.read()
    with open("${dir}/new-" + str(index), "w") as file:
        file.write("y")
json.dumps(0)
`);
    expect(host.openDescriptors()).toBe(before);
  });

  it("opens a created file once, with the mode and flags Python asked for", async () => {
    const dir = await directory("create-once");
    host.calls.length = 0;
    python(`
os.close(os.open("${dir}/one", os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600))
json.dumps(0)
`);
    expect(host.calls.filter(call => call === `open ${dir}/one`)).toHaveLength(1);
    expect(python(`json.dumps(failure(lambda: os.open("${dir}/one", os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)))`)).toMatchObject({ class: "FileExistsError", name: "EEXIST" });
  });
});
