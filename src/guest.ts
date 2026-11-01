import type { PyodideInterface } from "pyodide";
import type { nativeRunner } from "./native-bridge.ts";
import { PROCESS_PATCH_SOURCE } from "./python/process-patch.ts";
import { OXIDEVM_MODULE_SOURCE } from "./python/oxidevm-module.ts";
import { SLEEP_PATCH_SOURCE } from "./python/sleep-patch.ts";
import type { Interrupts } from "./signals.ts";
import type { SocketBridge } from "./socket-bridge.ts";

/** The identity and place of this process, which Python reports in place of Emscripten's fixed answers. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  /** The working directory Python starts in (inside a tree Python sees). */
  readonly cwd: string;
}

/** How a wait of the bridge ended: it never rejects, so that a wait Python gives up leaves no failure behind. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface GuestBridges {
  readonly run: ReturnType<typeof nativeRunner>;
  readonly sockets: SocketBridge;
  readonly interrupts: Interrupts;
}

/**
 * Makes the VM visible to Python: the JS functions behind `oxidevm.run` and the sockets, the `oxidevm` module itself,
 * the real process id, user, group and working directory, and a `time.sleep` that Ctrl+C ends. Python code never sees the
 * bridge module's name as part of a contract; it is private to the `oxidevm` module and the patches.
 */
export function installGuest(py: PyodideInterface, identity: ProcessIdentity, bridges: GuestBridges): void {
  const { sockets, interrupts } = bridges;
  // Each wait holds a Ctrl+C that arrives meanwhile, for Python to raise once it runs again (see Interrupts). It resolves
  // with its outcome even when it fails: a KeyboardInterrupt can make Python give up a wait before it awaits it, and a
  // rejection nobody awaits would surface later as an unhandled rejection and as an unretrieved future on stderr.
  const held = <T>(waiting: Promise<T>): Promise<Outcome<T>> => waiting
    .then((value): Outcome<T> => ({ ok: true, value }), (error: unknown): Outcome<T> => ({ ok: false, error }))
    .finally(() => { interrupts.hold(); });
  py.registerJsModule("_oxidevm_bridge", {
    run: (argumentsJSON: unknown, input: unknown, timeoutMs: unknown) => held(bridges.run(argumentsJSON, input, timeoutMs)),
    connect: (kind: unknown, target: unknown, port: unknown, timeoutMs: unknown) => held(sockets.connect(kind, target, port, timeoutMs)),
    send: (handle: unknown, data: unknown, timeoutMs: unknown) => held(sockets.send(handle, data, timeoutMs)),
    recv: (handle: unknown, size: unknown, timeoutMs: unknown) => held(sockets.recv(handle, size, timeoutMs)),
    close: (handle: unknown) => held(sockets.close(handle)),
    sleep: (milliseconds: unknown) => interrupts.sleep(typeof milliseconds === "number" && milliseconds > 0 ? milliseconds : 0),
    // Called by Python after every wait: a held Ctrl+C raises KeyboardInterrupt now, as after any system call in CPython.
    check_interrupt: () => { interrupts.restore(); py.checkInterrupt(); },
    // Raises the failure of a wait in Python, as the JsException it would have been.
    fail: (error: unknown) => { throw error; },
  });
  py.registerJsModule("_oxidevm_process", { pid: identity.pid, uid: identity.uid, gid: identity.gid, cwd: identity.cwd });
  py.runPython(PROCESS_PATCH_SOURCE);
  // A namespace of its own, so that the patch's names stay out of the globals of Pyodide's own __main__.
  const namespace: unknown = py.toPy({});
  if (!(namespace instanceof py.ffi.PyProxy)) throw new Error("Pyodide did not convert an empty namespace to a Python dict");
  try {
    py.runPython(SLEEP_PATCH_SOURCE, { globals: namespace });
  } finally {
    namespace.destroy();
  }
  const sitePackages: unknown = py.runPython("import sysconfig\nsysconfig.get_path('purelib')");
  if (typeof sitePackages !== "string") throw new Error("Pyodide did not report its site-packages directory");
  py.FS.writeFile(`${sitePackages}/oxidevm.py`, OXIDEVM_MODULE_SOURCE);
  py.runPython("import importlib\nimportlib.invalidate_caches()");
}
