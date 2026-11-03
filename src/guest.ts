import type { PyodideInterface } from "pyodide";
import type { nativeRunner } from "./native-bridge.ts";
import { HIDE_BRIDGE_SOURCE } from "./python/hide-bridge.ts";
import { HTTP_CLIENTS_PATCH_SOURCE } from "./python/http-clients-patch.ts";
import { LAZY_PACKAGES_SOURCE } from "./python/lazy-packages.ts";
import { SOCKET_PATCH_SOURCE } from "./python/socket-patch.ts";
import { SSL_PATCH_SOURCE } from "./python/ssl-patch.ts";
import type { NetBridge } from "./net-bridge.ts";
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

/** Runs Python in a namespace of its own, so that its names stay out of the globals of Pyodide's own __main__. */
function runIsolated(py: PyodideInterface, source: string): void {
  const namespace: unknown = py.toPy({});
  if (!(namespace instanceof py.ffi.PyProxy)) throw new Error("Pyodide did not convert an empty namespace to a Python dict");
  try {
    py.runPython(source, { globals: namespace });
  } finally {
    namespace.destroy();
  }
}

/** The shipped packages that load when imported (`LoadedPython` of src/python-loader.ts). */
export interface ShippedPackages {
  /** Top-level module names to the package that provides them. */
  readonly imports: ReadonlyMap<string, string>;
  /** The packages loaded before the program started. */
  readonly loaded: ReadonlySet<string>;
  /** Loads packages and what they need, and resolves with every package now loaded. */
  install(names: readonly string[]): Promise<readonly string[]>;
}

export interface GuestBridges {
  readonly run: ReturnType<typeof nativeRunner>;
  readonly sockets: SocketBridge;
  readonly interrupts: Interrupts;
  /** Absent: no package loads on import (the finder is not installed). */
  readonly packages?: ShippedPackages;
  /**
   * The VM's resolver and TLS client for Python's `socket` and `ssl` (src/net-bridge.ts). Absent: names and TLS stay
   * Pyodide's own (unit tests that do not need them).
   */
  readonly net?: NetBridge;
}

/**
 * Makes the VM visible to Python: the JS functions behind `oxidevm.run` and the sockets, the `oxidevm` module itself,
 * the real process id, user, group and working directory, a `time.sleep` that Ctrl+C ends, and, with `packages`, the
 * import hook that loads a shipped package when the program imports it, and, with `net`, names and TLS for `socket` and
 * `ssl` through the VM. Python code never sees the
 * bridge module's name as part of a contract; it is private to the `oxidevm` module and the patches.
 */
export function installGuest(py: PyodideInterface, identity: ProcessIdentity, bridges: GuestBridges): void {
  const { sockets, interrupts, net } = bridges;
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
    resolve: (name: unknown) => net?.resolve(name),
    tls_open: (serverName: unknown, alpn: unknown, trust: unknown) => net?.tlsOpen(serverName, alpn, trust),
    tls_receive: (handle: unknown, ciphertext: unknown) => net?.tlsReceive(handle, ciphertext),
    tls_take: (handle: unknown) => net?.tlsTake(handle),
    tls_send: (handle: unknown, plaintext: unknown) => net?.tlsSend(handle, plaintext),
    tls_plaintext: (handle: unknown, max: unknown) => net?.tlsPlaintext(handle, max),
    tls_status: (handle: unknown) => net?.tlsStatus(handle),
    tls_peer: (handle: unknown) => net?.tlsPeer(handle),
    tls_peer_certificate: (handle: unknown) => net?.tlsPeerCertificate(handle),
    decode_certificate: (der: unknown) => net?.decodeCertificate(der),
    receive_timeout: (fd: unknown, seconds: unknown) => net?.receiveTimeout(fd, seconds),
    tls_close: (handle: unknown) => net?.tlsClose(handle),
    tls_free: (handle: unknown) => { net?.tlsFree(handle); },
    load_packages: (name: unknown) => held(typeof name === "string" && bridges.packages !== undefined ? bridges.packages.install([name]) : Promise.reject(new TypeError("no package to load"))),
    // Called by Python after every wait: a held Ctrl+C raises KeyboardInterrupt now, as after any system call in CPython.
    check_interrupt: () => { interrupts.restore(); py.checkInterrupt(); },
    // Raises the failure of a wait in Python, as the JsException it would have been.
    fail: (error: unknown) => { throw error; },
  });
  py.registerJsModule("_oxidevm_process", { pid: identity.pid, uid: identity.uid, gid: identity.gid, cwd: identity.cwd });
  py.runPython(PROCESS_PATCH_SOURCE);
  runIsolated(py, SLEEP_PATCH_SOURCE);
  if (net !== undefined) {
    runIsolated(py, SOCKET_PATCH_SOURCE);
    runIsolated(py, SSL_PATCH_SOURCE);
    runIsolated(py, HTTP_CLIENTS_PATCH_SOURCE);
  }
  if (bridges.packages !== undefined) {
    py.registerJsModule("_oxidevm_packages", { imports: Object.fromEntries(bridges.packages.imports), loaded: [...bridges.packages.loaded] });
    runIsolated(py, LAZY_PACKAGES_SOURCE);
  }
  const sitePackages: unknown = py.runPython("import sysconfig\nsysconfig.get_path('purelib')");
  if (typeof sitePackages !== "string") throw new Error("Pyodide did not report its site-packages directory");
  py.FS.writeFile(`${sitePackages}/oxidevm.py`, OXIDEVM_MODULE_SOURCE);
  py.runPython("import importlib\nimportlib.invalidate_caches()");
}

/**
 * Hides Pyodide's bridge to JavaScript from the program, which a program started as a command must not import (engine
 * ADR 0027): see src/python/hide-bridge.ts. Call it after `installGuest`, whose `oxidevm` module it imports first.
 */
export function hideJavaScript(py: PyodideInterface): void {
  runIsolated(py, HIDE_BRIDGE_SOURCE);
}
