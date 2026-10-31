import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import type { NativeRunRequest } from "@oxidevm/sdk/wasm";
import type { PyodideInterface } from "pyodide";
import { installGuest } from "../../src/guest.ts";
import { nativeRunner } from "../../src/native-bridge.ts";
import { invocationOf, pythonEnvironment, runScript } from "../../src/script.ts";
import { socketBridge } from "../../src/socket-bridge.ts";
import { attachStandardStreams } from "../../src/stdio.ts";
import { mountWorkspace } from "../../src/workspace-fs.ts";
import { fakeProcess } from "./fake-process.ts";
import type { Child, FakeProcess } from "./fake-process.ts";
import { fakeSockets } from "./fake-sockets.ts";
import type { FakeSockets } from "./fake-sockets.ts";
import { fakeStdio } from "./fake-stdio.ts";
import type { FakeStdio } from "./fake-stdio.ts";
import { nodeFiles } from "./node-files.ts";
import type { NodeFiles } from "./node-files.ts";
import { startPyodide } from "./pyodide-node.ts";

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
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
  /** Ends the module the way the runner does when `main` returns: aborts its signal and closes leftover sockets. */
  readonly stop: () => Promise<void>;
  /** Writes `source` to a script in the workspace and runs it as `main` would. */
  run(source: string, options?: { readonly args?: readonly string[]; readonly name?: string; readonly stdin?: string }): Promise<RunResult>;
  dispose(): Promise<void>;
}

export const IDENTITY = { pid: 4242, uid: 1000, gid: 1001, cwd: "/workspace" } as const;

export async function startGuest(behave: (argv: readonly string[]) => Child = () => ({})): Promise<GuestFixture> {
  const root = await mkdtemp(join(tmpdir(), "pyodide-guest-"));
  const files = nodeFiles(root);
  const stdio = fakeStdio();
  const process = fakeProcess(behave);
  const sockets = fakeSockets();
  const lifetime = new AbortController();
  const nativeRequests: NativeRunRequest[] = [];
  const spyKit = { ...kit, runNative: (host: Parameters<typeof kit.runNative>[0], request: NativeRunRequest) => { nativeRequests.push(request); return kit.runNative(host, request); } };
  const bridges = { run: nativeRunner({ ...process.host, kit: spyKit, signal: lifetime.signal }), sockets: socketBridge({ sockets: sockets.sockets, kit, signal: lifetime.signal }) };
  const py = await startPyodide(pythonEnvironment({ PATH: "/usr/bin", PYTHONHOME: "/usr", FOO: "bar" }));
  mountWorkspace(py.FS, files.files, kit.errno);
  attachStandardStreams(py, stdio.files, stdio.streams, kit.errno);
  installGuest(py, IDENTITY, bridges);

  return {
    py, files, process, sockets, stdio, nativeRequests,
    stop: async () => { lifetime.abort(); await bridges.sockets.closeAll(); },
    async run(source, options = {}) {
      const name = options.name ?? "program.py";
      await writeFile(join(root, name), source);
      stdio.take();
      stdio.feed(options.stdin ?? "");
      const invocation = invocationOf([`/workspace/${name}`, ...(options.args ?? [])], "/workspace");
      if (invocation === undefined) throw new Error("no invocation");
      const status = await runScript(py, invocation, source);
      return { status, ...stdio.take() };
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
