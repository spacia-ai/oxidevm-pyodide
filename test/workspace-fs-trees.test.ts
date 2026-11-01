import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyncFiles } from "../src/host-types.ts";
import { normalizePath, PYODIDE_DIRECTORIES, visibleTrees, within } from "../src/workspace-fs.ts";
import { startWorkspace } from "./support/workspace-fixture.ts";
import type { Workspace } from "./support/workspace-fixture.ts";

// Which of the VM's directories Python sees (/workspace, /tmp and $HOME), and the bridge mounted at each of them in the
// real Pyodide. The operations themselves are tested on /workspace in workspace-fs.test.ts.

/** A VM whose only entries are these directories and files; everything else does not exist. */
function vmWith(directories: readonly string[], files: readonly string[] = []): Pick<SyncFiles, "stat"> {
  return {
    stat(path) {
      const name = typeof path === "string" ? path : new TextDecoder().decode(path);
      const mode = directories.includes(name) ? 0o40755 : files.includes(name) ? 0o100644 : undefined;
      if (mode === undefined) throw new LinuxError(2);
      return { device: 1n, inode: 1n, links: 1n, mode, uid: 0, gid: 0, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n };
    },
  };
}

describe("normalizePath and within", () => {
  it("normalises an absolute path the way the kernel walks it, without looking at the files", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["/", "/"], ["//", "/"], ["/workspace/", "/workspace"], ["/workspace//a/./b/", "/workspace/a/b"], ["/workspace/a/../b", "/workspace/b"],
      ["/workspace/../etc/passwd", "/etc/passwd"], ["/..", "/"], ["/../../tmp", "/tmp"], ["/a/b/c/../../..", "/"],
    ];
    for (const [given, expected] of cases) expect(normalizePath(given), given).toBe(expected);
  });

  it("puts a path within a tree when it is the tree or below it, and never a look-alike", () => {
    expect(within("/workspace", "/workspace")).toBe(true);
    expect(within("/workspace/a/b", "/workspace")).toBe(true);
    for (const outside of ["/workspace2", "/workspacefoo/bar", "/work", "/", "/tmp"]) expect(within(outside, "/workspace"), outside).toBe(false);
    expect(within("/anything", "/")).toBe(true);
  });
});

describe("visibleTrees", () => {
  const vm = vmWith(["/workspace", "/tmp", "/home", "/home/user", "/home/pyodide", "/home/pyodide/sub", "/root", "/lib", "/lib/x", "/dev", "/proc", "/proc/1", "/workspace/me", "/tmp/me", "/srv/data"], ["/home/file"]);

  it("always has the workspace and /tmp, and the home directory when it is an existing directory of its own", () => {
    expect(visibleTrees(undefined, vm)).toEqual(["/workspace", "/tmp"]);
    expect(visibleTrees("/home/user", vm)).toEqual(["/workspace", "/tmp", "/home/user"]);
    expect(visibleTrees("/root", vm)).toEqual(["/workspace", "/tmp", "/root"]);
    expect(visibleTrees("/srv/data", vm)).toEqual(["/workspace", "/tmp", "/srv/data"]);
  });

  it("takes the home directory as Linux would resolve its name", () => {
    expect(visibleTrees("/home/user/", vm)).toEqual(["/workspace", "/tmp", "/home/user"]);
    expect(visibleTrees("/home/./pyodide/../user", vm)).toEqual(["/workspace", "/tmp", "/home/user"]);
  });

  it("leaves out a home directory that is missing, not a directory, or not an absolute path", () => {
    for (const home of ["/home/nobody", "/home/file", "home/user", "", "~"]) expect(visibleTrees(home, vm), home).toEqual(["/workspace", "/tmp"]);
  });

  it("leaves out a home directory at, inside or around one of Pyodide's own directories", () => {
    expect(PYODIDE_DIRECTORIES).toEqual(["/", "/lib", "/dev", "/proc", "/home/pyodide"]);
    for (const home of ["/", "/lib", "/lib/x", "/dev", "/proc", "/proc/1", "/home/pyodide", "/home/pyodide/sub", "/home"]) expect(visibleTrees(home, vm), home).toEqual(["/workspace", "/tmp"]);
  });

  it("does not mount a home directory twice when the workspace or /tmp already shows it", () => {
    for (const home of ["/workspace", "/workspace/me", "/tmp", "/tmp/me"]) expect(visibleTrees(home, vm), home).toEqual(["/workspace", "/tmp"]);
  });

  it("leaves out /workspace or /tmp when the VM has no such directory", () => {
    expect(visibleTrees("/home/user", vmWith(["/tmp", "/home/user"]))).toEqual(["/tmp", "/home/user"]);
    expect(visibleTrees(undefined, vmWith(["/workspace"], ["/tmp"]))).toEqual(["/workspace"]);
  });
});

describe("the trees in Pyodide", () => {
  let workspace: Workspace;
  beforeAll(async () => { workspace = await startWorkspace({ faults: {} }, ["/tmp", "/home/user"]); });
  afterAll(async () => { await workspace.dispose(); });

  const real = (tree: string, name: string): string => join(workspace.trees[tree] ?? "", name);

  it("show the VM's /tmp and home directory at the same paths, both ways", async () => {
    await writeFile(real("/tmp", "from-linux.txt"), "in /tmp");
    await mkdir(real("/home/user", ".config"));
    await writeFile(real("/home/user", ".config/settings"), "in home");
    const seen = workspace.python(`
with open("/tmp/from-python.txt", "w") as file:
    file.write("python wrote /tmp")
os.makedirs("/home/user/.cache/tool", exist_ok=True)
with open("/home/user/.cache/tool/state", "w") as file:
    file.write("python wrote home")
json.dumps({"tmp": open("/tmp/from-linux.txt").read(), "home": open("/home/user/.config/settings").read(), "listing": sorted(os.listdir("/tmp"))})
`);
    expect(seen).toEqual({ tmp: "in /tmp", home: "in home", listing: ["from-linux.txt", "from-python.txt"] });
    expect(await readFile(real("/tmp", "from-python.txt"), "utf8")).toBe("python wrote /tmp");
    expect(await readFile(real("/home/user", ".cache/tool/state"), "utf8")).toBe("python wrote home");
  });

  it("keeps Pyodide's own directories as they were", () => {
    expect(workspace.python(`
import sys
json.dumps({"stdlib": os.path.isdir("/lib/python3.14"), "pyodide_home": os.path.isdir("/home/pyodide"), "site": any(path.startswith("/lib/") for path in sys.path)})
`)).toEqual({ stdlib: true, pyodide_home: true, site: true });
  });

  it("refuses to rename across two trees, as between two file systems, and shutil.move copies instead", async () => {
    await writeFile(real("/tmp", "moving.txt"), "moved across");
    expect(workspace.python(`
import shutil
result = failure(lambda: os.rename("/tmp/moving.txt", "/workspace/moved.txt"))
shutil.move("/tmp/moving.txt", "/workspace/moved.txt")
json.dumps(result)
`)).toMatchObject({ name: "EXDEV" });
    expect(await readFile(real("/workspace", "moved.txt"), "utf8")).toBe("moved across");
    expect(await readdir(workspace.trees["/tmp"] ?? "")).not.toContain("moving.txt");
  });
});
