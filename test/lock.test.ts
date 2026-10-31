import { describe, expect, it } from "vitest";
import { decodeLockfile, wheelsFor } from "../src/lock.ts";

const LOCK = JSON.stringify({
  info: { abi_version: "2026_0" },
  packages: {
    pandas: { name: "pandas", file_name: "pandas-3.whl", depends: ["numpy", "python-dateutil"], sha256: "x" },
    numpy: { name: "numpy", file_name: "numpy-2.whl", depends: [] },
    "python-dateutil": { name: "python-dateutil", file_name: "python_dateutil-2.whl", depends: ["six"] },
    six: { file_name: "six-1.whl" },
    matplotlib: { file_name: "matplotlib-3.whl", depends: ["numpy", "six"] },
    loop: { file_name: "loop-1.whl", depends: ["loop"] },
  },
});

function failure(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "not an error";
  }
  return "no failure";
}

describe("decodeLockfile", () => {
  it("reads the file names and dependencies of every package", () => {
    const lock = decodeLockfile(LOCK);
    expect([...lock.keys()].sort()).toEqual(["loop", "matplotlib", "numpy", "pandas", "python-dateutil", "six"]);
    expect(lock.get("pandas")).toEqual({ name: "pandas", fileName: "pandas-3.whl", depends: ["numpy", "python-dateutil"] });
    expect(lock.get("six")).toEqual({ name: "six", fileName: "six-1.whl", depends: [] });
  });

  it("refuses text that is not a Pyodide lock", () => {
    for (const text of ["", "not json", "[]", "null", '{"packages":[]}', '{"packages":null}', "{}"]) {
      expect(failure(() => decodeLockfile(text)), text).toContain("lock");
    }
  });

  it("refuses a package whose file name or dependencies have the wrong type", () => {
    for (const entry of [{}, { file_name: 3 }, { file_name: "" }, { file_name: "a.whl", depends: "numpy" }, { file_name: "a.whl", depends: [1] }, "text", null, []]) {
      expect(failure(() => decodeLockfile(JSON.stringify({ packages: { a: entry } }))), JSON.stringify(entry)).toContain("package a");
    }
  });

  it("does not let a package named like an object member change the result", () => {
    const lock = decodeLockfile('{"packages":{"__proto__":{"file_name":"p.whl"},"constructor":{"file_name":"c.whl"}}}');
    expect(lock.get("constructor")?.fileName).toBe("c.whl");
    expect(lock.get("toString")).toBeUndefined();
  });
});

describe("wheelsFor", () => {
  it("returns each requested package and everything it needs, once, in a stable order", () => {
    const lock = decodeLockfile(LOCK);
    expect(wheelsFor(lock, ["pandas"]).map(item => item.name)).toEqual(["numpy", "pandas", "python-dateutil", "six"]);
    expect(wheelsFor(lock, ["matplotlib", "pandas"]).map(item => item.name)).toEqual(["matplotlib", "numpy", "pandas", "python-dateutil", "six"]);
    expect(wheelsFor(lock, ["pandas", "pandas", "numpy"]).map(item => item.name)).toEqual(["numpy", "pandas", "python-dateutil", "six"]);
  });

  it("returns nothing for nothing", () => {
    expect(wheelsFor(decodeLockfile(LOCK), [])).toEqual([]);
  });

  it("survives a dependency cycle", () => {
    expect(wheelsFor(decodeLockfile(LOCK), ["loop"]).map(item => item.name)).toEqual(["loop"]);
  });

  it("names a package that the lock does not know, whether requested or needed", () => {
    expect(failure(() => wheelsFor(decodeLockfile(LOCK), ["scipy"]))).toContain("scipy");
    const broken = decodeLockfile(JSON.stringify({ packages: { a: { file_name: "a.whl", depends: ["missing"] } } }));
    expect(failure(() => wheelsFor(broken, ["a"]))).toContain("missing");
  });
});
