import { stat, symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import type { PyodideInterface } from "pyodide";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { field } from "./support/decode.ts";
import type { NodeFiles } from "./support/node-files.ts";
import { startWorkspace } from "./support/workspace-fixture.ts";
import type { Faults, Workspace } from "./support/workspace-fixture.ts";

// What Emscripten sets on a file through `setattr` (mode, size and the two times), against the real Pyodide and a
// directory of this machine that stands in for the VM's /workspace (see support/workspace-fixture.ts).

let workspace: Workspace;
let root: string;
let host: NodeFiles;
let py: PyodideInterface;
const faults: Faults = {};

const python = (code: string): unknown => workspace.python(code);
const directory = (name: string): Promise<string> => workspace.directory(name);

beforeAll(async () => {
  workspace = await startWorkspace({ faults });
  ({ root, host, py } = workspace);
});

afterAll(async () => {
  await workspace.dispose();
});

/** A function of Emscripten's `FS`, such as `utime`, called with arguments that its own types would not allow. */
function emscripten(name: string): (...args: unknown[]) => unknown {
  const member: unknown = Reflect.get(py.FS, name);
  if (typeof member !== "function") throw new Error(`Emscripten's FS.${name} is missing`);
  return (...args) => {
    const result: unknown = Reflect.apply(member, py.FS, args);
    return result;
  };
}

/** Calls the `setattr` of the node at `path` with exactly these attributes, as `FS.chmod`, `FS.truncate` and `FS.utime` do. */
function setattr(path: string, attributes: Readonly<Record<string, unknown>>): void {
  const node = py.FS.lookupPath(path, {}).node;
  const operations: unknown = Reflect.get(node, "node_ops");
  const handler: unknown = Reflect.get(typeof operations === "object" && operations !== null ? operations : {}, "setattr");
  if (typeof handler !== "function") throw new Error("the node has no setattr");
  Reflect.apply(handler, operations, [node, attributes]);
}

/** Emscripten's EINVAL. */
const EINVAL = 28;

/** The errno of the error that `work` throws or "accepted" when it does not. */
function refusal(work: () => unknown): unknown {
  try {
    work();
  } catch (error: unknown) {
    return field(error, "errno");
  }
  return "accepted";
}

describe("attributes that are not whole numbers", () => {
  it("refuses a mode or a size that is not a whole number, and a size below zero, without asking the host", async () => {
    const dir = await directory("attributes-invalid");
    await writeFile(join(root, "attributes-invalid/file"), "0123456789");
    host.calls.length = 0;
    const bad: readonly Record<string, unknown>[] = [
      { size: 1.5 }, { size: Number.NaN }, { size: -1 }, { size: 2 ** 53 }, { size: "3" }, { size: 3n },
      { mode: 0o600 + 0.5 }, { mode: Number.NaN }, { mode: 2 ** 53 }, { mode: "0600" }, { mode: 384n },
    ];
    expect(bad.map(attributes => refusal(() => { setattr(`${dir}/file`, attributes); }))).toEqual(bad.map(() => EINVAL));
    expect(host.calls).toEqual([]);
    expect(await readFile(join(root, "attributes-invalid/file"), "utf8")).toBe("0123456789");
  });

  it("takes a whole mode and a whole size, even zero", async () => {
    const dir = await directory("attributes-valid");
    await writeFile(join(root, "attributes-valid/file"), "0123456789", { mode: 0o644 });
    setattr(`${dir}/file`, { size: 4 });
    expect(await readFile(join(root, "attributes-valid/file"), "utf8")).toBe("0123");
    setattr(`${dir}/file`, { mode: 0o100600 });
    expect((await stat(join(root, "attributes-valid/file"))).mode & 0o7777).toBe(0o600);
    setattr(`${dir}/file`, { size: 0 });
    expect((await stat(join(root, "attributes-valid/file"))).size).toBe(0);
  });
});

describe("file times", () => {
  const SECOND = 1_000_000_000n;

  it("hands the host the exact milliseconds of both times, for the file that is named", async () => {
    const dir = await directory("times");
    await writeFile(join(root, "times/file"), "x");
    host.utimes.length = 0;
    python(`
os.utime("${dir}/file", ns=(1_700_000_000_123_000_000, 1_600_000_000_456_000_000))
json.dumps(0)
`);
    expect(host.utimes).toEqual([{ path: `${dir}/file`, access: new Date(1_700_000_000_123), modification: new Date(1_600_000_000_456), followLinks: true }]);
    const real = await stat(join(root, "times/file"), { bigint: true });
    // Node writes times as floating-point seconds, so the machine's own file can be a few hundred nanoseconds off.
    expect(real.mtimeNs / 1_000_000n).toBeGreaterThanOrEqual(1_600_000_000_455n);
    expect(real.mtimeNs / SECOND).toBe(1_600_000_000n);
    expect(real.atimeNs / SECOND).toBe(1_700_000_000n);
  });

  it("follows a symbolic link to the file it points at", async () => {
    const dir = await directory("times-link");
    await writeFile(join(root, "times-link/target"), "x");
    await symlink("target", join(root, "times-link/link"));
    host.utimes.length = 0;
    python(`
os.utime("${dir}/link", ns=(2_000_000_000_001_000_000, 2_000_000_000_002_000_000))
json.dumps(0)
`);
    expect(host.utimes).toEqual([{ path: `${dir}/target`, access: new Date(2_000_000_000_001), modification: new Date(2_000_000_000_002), followLinks: true }]);
  });

  it("sets both times to the present when Python gives none", async () => {
    const dir = await directory("times-now");
    await writeFile(join(root, "times-now/file"), "x");
    host.utimes.length = 0;
    const before = Date.now();
    python(`os.utime("${dir}/file", None)\njson.dumps(0)`);
    const [call] = host.utimes;
    expect(host.utimes).toHaveLength(1);
    for (const time of [call?.access, call?.modification]) {
      expect(time).toBeInstanceOf(Date);
      expect(time instanceof Date ? time.getTime() : 0).toBeGreaterThanOrEqual(before - 1000);
      expect(time instanceof Date ? time.getTime() : 0).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("leaves a time unchanged when Emscripten says to omit it", async () => {
    const dir = await directory("times-omit");
    await writeFile(join(root, "times-omit/file"), "x");
    host.utimes.length = 0;
    const utime = emscripten("utime");
    utime(`${dir}/file`, null, 5_000);
    utime(`${dir}/file`, 6_000.9, null);
    expect(host.utimes).toEqual([
      { path: `${dir}/file`, access: "omit", modification: new Date(5_000), followLinks: true },
      { path: `${dir}/file`, access: new Date(6_000), modification: "omit", followLinks: true },
    ]);
  });

  it("refuses a time that is not a number of milliseconds with EINVAL, before asking the host", async () => {
    const dir = await directory("times-invalid");
    await writeFile(join(root, "times-invalid/file"), "x");
    host.utimes.length = 0;
    const utime = emscripten("utime");
    const bad: readonly unknown[] = ["yesterday", Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, -8.64e15 - 1, {}, 10n];
    expect(bad.map(time => refusal(() => utime(`${dir}/file`, time, 0)))).toEqual(bad.map(() => EINVAL));
    expect(host.utimes).toEqual([]);
  });

  it("reaches Python as the OSError of the host's failure", async () => {
    const dir = await directory("times-failure");
    await writeFile(join(root, "times-failure/file"), "x");
    faults.utimes = () => { throw new LinuxError(1); };
    try {
      expect(python(`json.dumps(failure(lambda: os.utime("${dir}/file", (1, 1))))`)).toMatchObject({ class: "PermissionError", name: "EPERM" });
    } finally {
      delete faults.utimes;
    }
  });

  it("is applied after a size that comes in the same request, so that an explicit time is the one that remains", async () => {
    const dir = await directory("times-order");
    await writeFile(join(root, "times-order/file"), "0123456789");
    host.calls.length = 0;
    setattr(`${dir}/file`, { mode: 0o600, size: 3, atime: 5_000, mtime: 6_000 });
    expect(host.calls).toEqual([`chmod ${dir}/file`, `truncate ${dir}/file 3`, `utimes ${dir}/file`]);
  });
});
