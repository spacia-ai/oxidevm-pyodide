import type { Host } from "@oxidevm/sdk/wasm";
import type { FileDescriptor } from "../../src/host-types.ts";
import type { NativeHost } from "../../src/native-bridge.ts";
import { descriptor, processId } from "./brands.ts";

/** What a scripted native child does. */
export interface Child {
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string;
  /** How it ends when nothing signals it: with a status (the default is 0) or, as if something else sent one, by a signal. */
  readonly exit?: { readonly kind: "exited"; readonly code: number } | { readonly kind: "signaled"; readonly signal: null; readonly signalNumber: number };
  /** The child keeps running until it is sent a signal. */
  readonly hang?: boolean;
}

export interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly stdio: unknown;
  readonly pid: number;
  /** What was written to the child's standard input. */
  input: string;
  /** Signals sent to it. */
  readonly signals: number[];
  closed: number;
}

export interface FakeProcess {
  readonly host: Pick<NativeHost, "files" | "process">;
  readonly spawned: Spawned[];
}

type Waiter = () => void;

/**
 * A stand-in for the VM's process and pipe operations. `behave` decides what each spawned child does from its command
 * line; a child that hangs ends only when it is signalled, like a real one.
 */
export function fakeProcess(behave: (argv: readonly string[]) => Child): FakeProcess {
  const spawned: Spawned[] = [];
  const pipes = new Map<number, { readonly record: Spawned; readonly kind: "stdin" | "stdout" | "stderr"; readonly child: Child; offset: number }>();
  const ended = new Map<number, { done: boolean; waiters: Waiter[] }>();

  const settle = (pid: number): void => {
    const state = ended.get(pid);
    if (state === undefined) return;
    state.done = true;
    for (const wake of state.waiters.splice(0)) wake();
  };
  const untilEnded = (pid: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const state = ended.get(pid);
    if (state?.done !== false) { resolve(); return; }
    state.waiters.push(resolve);
    signal?.addEventListener("abort", () => { reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }, { once: true });
  });

  const files: NativeHost["files"] = {
    async read(fd, count, options) {
      const pipe = pipes.get(fd);
      if (pipe === undefined || pipe.kind === "stdin") return new Uint8Array(0);
      const data = pipe.kind === "stdout" ? pipe.child.stdout ?? "" : pipe.child.stderr ?? "";
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (pipe.offset < bytes.length) {
        const chunk = bytes.slice(pipe.offset, pipe.offset + count);
        pipe.offset += chunk.length;
        return chunk;
      }
      if (pipe.child.hang === true) await untilEnded(pipe.record.pid, options?.signal);
      return new Uint8Array(0);
    },
    writeAll(fd, bytes) {
      const pipe = pipes.get(fd);
      if (pipe?.kind === "stdin") pipe.record.input += new TextDecoder().decode(bytes);
      return Promise.resolve();
    },
    close(fd) {
      const pipe = pipes.get(fd);
      if (pipe !== undefined) pipe.record.closed += 1;
      return Promise.resolve();
    },
  };

  const process: NativeHost["process"] = {
    spawn(spec, options) {
      options?.signal?.throwIfAborted();
      const argv = [spec.command, ...(spec.args ?? [])];
      const child = behave(argv);
      const pid = 1000 + spawned.length;
      const record: Spawned = { command: spec.command, args: spec.args ?? [], cwd: spec.cwd, stdio: spec.stdio, pid, input: "", signals: [], closed: 0 };
      spawned.push(record);
      ended.set(pid, { done: child.hang !== true, waiters: [] });
      const fds: FileDescriptor[] = ["stdin", "stdout", "stderr"].map((_kind, index) => descriptor(pid * 10 + index));
      for (const [index, kind] of (["stdin", "stdout", "stderr"] as const).entries()) pipes.set(pid * 10 + index, { record, kind, child, offset: 0 });
      const [stdin = descriptor(0), stdout = descriptor(0), stderr = descriptor(0)] = fds;
      return Promise.resolve({ pid: processId(pid), stdin, stdout, stderr });
    },
    async wait(pid, options) {
      await untilEnded(pid, options?.signal);
      const record = spawned.find(item => item.pid === pid);
      const killed = record?.signals.at(-1);
      if (killed !== undefined) return { kind: "signaled", signal: null, signalNumber: killed };
      return behave([record?.command ?? "", ...(record?.args ?? [])]).exit ?? { kind: "exited", code: 0 };
    },
    signal(pid, signalNumber) {
      spawned.find(item => item.pid === pid)?.signals.push(signalNumber);
      settle(pid);
      return Promise.resolve();
    },
  };
  return { host: { files, process }, spawned };
}

/** The `Host` members a test host copies from the real SDK so that behaviour matches the runner's. */
export type KitHost = Pick<Host, "kit">;
