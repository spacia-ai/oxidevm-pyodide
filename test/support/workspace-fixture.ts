import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PyodideInterface } from "pyodide";
import type { SyncFiles } from "../../src/host-types.ts";
import { mountWorkspace } from "../../src/workspace-fs.ts";
import { errno, nodeFiles } from "./node-files.ts";
import type { NodeFiles } from "./node-files.ts";
import { startPyodide } from "./pyodide-node.ts";

/** Host operations that fail or answer differently, switched on for one test and removed again afterwards. */
export interface Faults {
  lstat?: (path: string) => ReturnType<SyncFiles["lstat"]>;
  read?: () => never;
  /** What a read answers instead of the file's bytes, given the count that was asked for: a host that says too much. */
  reply?: (count: number) => Uint8Array;
  utimes?: () => never;
  /** Runs just before the host opens a file, so that a test can have something else (Linux) act in between. */
  beforeOpen?: (path: string) => void;
}

export interface WorkspaceHooks {
  readonly faults: Faults;
  /** Receives what the bridge reports as an unexpected host failure. */
  readonly report?: (error: unknown) => void;
  /** Receives the size of every write that reaches the host. */
  readonly onWrite?: (size: number) => void;
}

/**
 * The real Pyodide with the bridge mounted over a directory of this machine that stands in for the VM's `/workspace`.
 * Python does ordinary file work; the assertions look at the directory (what Linux would see) and at what Python reports,
 * including the errno values, which Emscripten numbers differently from Linux.
 */
export interface Workspace {
  readonly root: string;
  readonly host: NodeFiles;
  readonly py: PyodideInterface;
  /** Runs Python whose last expression is a JSON string, and returns what that decodes to. */
  python(code: string): unknown;
  /** Makes a directory of the workspace and returns its VM path. */
  directory(name: string): Promise<string>;
  dispose(): Promise<void>;
}

const PRELUDE = `import errno, hashlib, json, os
def failure(operation):
    try:
        operation()
    except OSError as error:
        return {"class": type(error).__name__, "errno": error.errno, "name": errno.errorcode.get(error.errno)}
    return None
`;

export async function startWorkspace(hooks: WorkspaceHooks): Promise<Workspace> {
  const { faults } = hooks;
  const root = await mkdtemp(join(tmpdir(), "pyodide-fs-"));
  const host = nodeFiles(root);
  const files: SyncFiles = {
    ...host.files,
    open: (path, flags, mode) => { faults.beforeOpen?.(typeof path === "string" ? path : ""); return host.files.open(path, flags, mode); },
    lstat: path => (faults.lstat === undefined ? host.files.lstat(path) : faults.lstat(typeof path === "string" ? path : "")),
    read: (fd, count) => {
      faults.read?.();
      return faults.reply === undefined ? host.files.read(fd, count) : faults.reply(count);
    },
    write: (fd, bytes) => { hooks.onWrite?.(bytes.length); return host.files.write(fd, bytes); },
    utimes: (path, access, modification, options) => { faults.utimes?.(); host.files.utimes(path, access, modification, options); },
  };
  const py = await startPyodide();
  mountWorkspace(py.FS, files, errno, error => { hooks.report?.(error); });

  return {
    root, host, py,
    python(code) {
      const text: unknown = py.runPython(`${PRELUDE}${code}`);
      if (typeof text !== "string") throw new Error("the Python code must end with json.dumps(...)");
      const value: unknown = JSON.parse(text);
      return value;
    },
    async directory(name) {
      await mkdir(join(root, name), { recursive: true });
      return `/workspace/${name}`;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
