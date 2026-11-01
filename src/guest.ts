import type { PyodideInterface } from "pyodide";
import type { nativeRunner } from "./native-bridge.ts";
import { PROCESS_PATCH_SOURCE } from "./python/process-patch.ts";
import { OXIDEVM_MODULE_SOURCE } from "./python/oxidevm-module.ts";
import type { SocketBridge } from "./socket-bridge.ts";

/** The identity and place of this process, which Python reports in place of Emscripten's fixed answers. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  /** The working directory Python starts in (inside a tree Python sees). */
  readonly cwd: string;
}

export interface GuestBridges {
  readonly run: ReturnType<typeof nativeRunner>;
  readonly sockets: SocketBridge;
}

/**
 * Makes the VM visible to Python: the JS functions behind `oxidevm.run` and the sockets, the `oxidevm` module itself,
 * and the real process id, user, group and working directory. Python code never sees the bridge module's name as part of
 * a contract; it is private to the `oxidevm` module.
 */
export function installGuest(py: PyodideInterface, identity: ProcessIdentity, bridges: GuestBridges): void {
  const { sockets } = bridges;
  py.registerJsModule("_oxidevm_bridge", {
    run: bridges.run,
    connect: (kind: unknown, target: unknown, port: unknown, timeoutMs: unknown) => sockets.connect(kind, target, port, timeoutMs),
    send: (handle: unknown, data: unknown, timeoutMs: unknown) => sockets.send(handle, data, timeoutMs),
    recv: (handle: unknown, size: unknown, timeoutMs: unknown) => sockets.recv(handle, size, timeoutMs),
    close: (handle: unknown) => sockets.close(handle),
  });
  py.registerJsModule("_oxidevm_process", { pid: identity.pid, uid: identity.uid, gid: identity.gid, cwd: identity.cwd });
  py.runPython(PROCESS_PATCH_SOURCE);
  const sitePackages: unknown = py.runPython("import sysconfig\nsysconfig.get_path('purelib')");
  if (typeof sitePackages !== "string") throw new Error("Pyodide did not report its site-packages directory");
  py.FS.writeFile(`${sitePackages}/oxidevm.py`, OXIDEVM_MODULE_SOURCE);
  py.runPython("import importlib\nimportlib.invalidate_caches()");
}
