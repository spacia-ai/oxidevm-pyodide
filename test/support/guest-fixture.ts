import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import type { NativeRunRequest } from "@oxidevm/sdk/wasm";
import type { PyodideInterface } from "pyodide";
import { installGuest } from "../../src/guest.ts";
import type { ShippedPackages } from "../../src/guest.ts";
import type { NetHost } from "../../src/host-types.ts";
import { netBridge } from "../../src/net-bridge.ts";
import { catchInterrupts, createInterrupts } from "../../src/signals.ts";
import { nativeRunner } from "../../src/native-bridge.ts";
import { parseCommandLine } from "../../src/cli.ts";
import { prepareProgram, pythonEnvironment, runProgram } from "../../src/script.ts";
import type { Launch } from "../../src/script.ts";
import { socketBridge } from "../../src/socket-bridge.ts";
import type { SocketBridge } from "../../src/socket-bridge.ts";
import { attachStandardStreams } from "../../src/stdio.ts";
import { mountTree, TMP, WORKSPACE } from "../../src/workspace-fs.ts";
import { fakeProcess } from "./fake-process.ts";
import type { Child, FakeProcess } from "./fake-process.ts";
import { fakeSockets } from "./fake-sockets.ts";
import type { FakeSockets } from "./fake-sockets.ts";
import { fakeSignals } from "./fake-signals.ts";
import { fakeStdio } from "./fake-stdio.ts";
import type { FakeStdio } from "./fake-stdio.ts";
import { nodeFiles } from "./node-files.ts";
import type { NodeFiles } from "./node-files.ts";
import { startPyodide } from "./pyodide-node.ts";

/** What the Python module asked of the socket bridge, with the values exactly as the bridge received them. */
export type SocketRequest =
  | { readonly operation: "connect" | "send"; readonly timeoutMs: unknown }
  | { readonly operation: "recv"; readonly timeoutMs: unknown; readonly size: unknown };

export interface RunResult {
  /** The exit status, or the signal the process ends with because the program left a KeyboardInterrupt unhandled. */
  readonly status: number | "SIGINT";
  readonly stdout: string;
  readonly stderr: string;
}

/** How a command line is started: from which directory, with what on standard input, under which name. */
export interface CommandLineOptions {
  readonly cwd?: string;
  readonly stdin?: string;
  readonly argv0?: string;
  readonly executable?: string;
  /** Whether standard input is a terminal (default: not). */
  readonly terminal?: boolean;
}

/**
 * A Pyodide that is set up the way the command sets it up (workspace mounted, standard streams attached, the `oxidevm`
 * module and the process identity installed), in Node, against fakes of the VM's files, processes and sockets.
 */
export interface GuestFixture {
  readonly py: PyodideInterface;
  readonly files: NodeFiles;
  readonly process: FakeProcess;
  readonly sockets: FakeSockets;
  readonly stdio: FakeStdio;
  /** Every request the native runner made to the kit. */
  readonly nativeRequests: NativeRunRequest[];
  /** Every connect, send and recv the Python module made to the socket bridge. */
  readonly socketRequests: SocketRequest[];
  /** Pyodide's interrupt buffer, as SIGINT's trap hands it over: writing 2 into [0] delivers a Ctrl+C. */
  readonly interrupts: Int32Array;
  /** Ends the module the way the runner does when `main` returns: aborts its signal and closes leftover sockets. */
  readonly stop: () => Promise<void>;
  /** Writes `source` to a script in the workspace and runs it as `python3 /workspace/<name> args...` would. */
  run(source: string, options?: { readonly args?: readonly string[]; readonly name?: string; readonly stdin?: string }): Promise<RunResult>;
  /**
   * Runs a command line the way `main` does once Python has started: the parser's warnings and a program that cannot be
   * read are reported on standard error (as `host.fail` does), anything else runs in this Pyodide.
   */
  runCommandLine(args: readonly string[], options?: CommandLineOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

export const IDENTITY = { pid: 4242, uid: 1000, gid: 1001, cwd: "/workspace" } as const;

/** The workspace and /tmp of the VM, each a directory of the test machine. */
/** What a guest may have beyond the defaults: packages that load on import, and the VM network for socket and ssl. */
export interface GuestExtras {
  readonly packages?: ShippedPackages;
  readonly net?: { readonly net: NetHost };
  /** The VM's /etc/ssl/cert.pem, as the module reads it to compare a program's authorities with (src/trust.ts). */
  readonly trustStore?: Uint8Array;
}

export async function startGuest(behave: (argv: readonly string[]) => Child = () => ({}), extras: GuestExtras = {}): Promise<GuestFixture> {
  const { packages } = extras;
  const root = await mkdtemp(join(tmpdir(), "pyodide-guest-"));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "tmp"));
  const stdio = fakeStdio();
  const files = nodeFiles({ [WORKSPACE]: join(root, "workspace"), [TMP]: join(root, "tmp") }, stdio.files);
  const process = fakeProcess(behave);
  const sockets = fakeSockets();
  const lifetime = new AbortController();
  const nativeRequests: NativeRunRequest[] = [];
  const spyKit = { ...kit, runNative: (host: Parameters<typeof kit.runNative>[0], request: NativeRunRequest) => { nativeRequests.push(request); return kit.runNative(host, request); } };
  const socketRequests: SocketRequest[] = [];
  const realSockets = socketBridge({ sockets: sockets.sockets, kit, signal: lifetime.signal });
  const recordingSockets: SocketBridge = {
    ...realSockets,
    connect: (kind, target, port, timeoutMs) => { socketRequests.push({ operation: "connect", timeoutMs }); return realSockets.connect(kind, target, port, timeoutMs); },
    send: (handle, data, timeoutMs) => { socketRequests.push({ operation: "send", timeoutMs }); return realSockets.send(handle, data, timeoutMs); },
    recv: (handle, size, timeoutMs) => { socketRequests.push({ operation: "recv", timeoutMs, size }); return realSockets.recv(handle, size, timeoutMs); },
  };
  const interrupts = createInterrupts();
  const net = extras.net === undefined ? undefined : netBridge(extras.net, error => kit.net.errno(error), () => extras.trustStore);
  const bridges = { run: nativeRunner({ ...process.host, kit: spyKit, signal: lifetime.signal }), sockets: recordingSockets, interrupts, ...(packages === undefined ? {} : { packages }), ...(net === undefined ? {} : { net }) };
  const py = await startPyodide(pythonEnvironment({ PATH: "/usr/bin", PYTHONHOME: "/usr", FOO: "bar", HOME: "/home/user" }), extras.net === undefined ? undefined : imports => { kit.emscripten.networkImports(imports); });
  for (const tree of [WORKSPACE, TMP]) mountTree(py.FS, files.files, kit.errno, tree);
  attachStandardStreams(py, stdio.files, stdio.streams, kit.errno);
  if (extras.net !== undefined) net?.attachSockets(kit.emscripten.network(extras.net, Reflect.get(py, "_module")));
  installGuest(py, IDENTITY, bridges);
  const trap = await catchInterrupts(fakeSignals().signals, interrupts);

  async function runCommandLine(args: readonly string[], options: CommandLineOptions = {}): Promise<RunResult> {
    const launch: Launch = { argv0: options.argv0 ?? "python3", args, cwd: options.cwd ?? IDENTITY.cwd, executable: options.executable ?? "/usr/local/bin/python3" };
    stdio.take();
    stdio.feed(options.stdin ?? "");
    const line = parseCommandLine(args);
    if (line.kind !== "run") throw new Error(`${args.join(" ")} is not a program to run`);
    const report = (text: string): void => { stdio.files.writeAll(stdio.streams.stderr, new TextEncoder().encode(`${text}\n`)); };
    line.warnings.forEach(report);
    const prepared = prepareProgram({ fs: files.files, errnoOf: kit.errno.of, stdin: stdio.streams.stdin, stdinIsTerminal: options.terminal === true }, launch, line);
    if (prepared.kind === "failed") {
      report(prepared.message);
      return { status: prepared.status, ...stdio.take() };
    }
    py.FS.chdir(launch.cwd);
    try {
      const outcome = await runProgram(py, prepared.request, () => { interrupts.arm(py); });
      return { status: outcome.kind === "exit" ? outcome.status : outcome.signal, ...stdio.take() };
    } finally {
      // Each run is a process of its own: Pyodide watches for Ctrl+C only once the next runner arms it again.
      py.setInterruptBuffer(new Int32Array(1));
      // The builtin exit() closes sys.stdin, as in CPython; the next process would have a fresh one.
      py.runPython("import sys as _s\nif _s.stdin.closed:\n    _s.stdin = open(0, 'r', encoding=_s.stdin.encoding, errors=_s.stdin.errors, closefd=False)\ndel _s");
    }
  }

  return {
    py, files, process, sockets, stdio, nativeRequests, socketRequests, runCommandLine, interrupts: trap.interruptBuffer,
    stop: async () => { lifetime.abort(); await realSockets.closeAll(); },
    async run(source, options = {}) {
      const name = options.name ?? "program.py";
      await writeFile(files.real(`/workspace/${name}`), source);
      return runCommandLine([`/workspace/${name}`, ...(options.args ?? [])], options.stdin === undefined ? {} : { stdin: options.stdin });
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
