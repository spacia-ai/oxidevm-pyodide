import { LinuxError } from "@oxidevm/sdk/js-process";
import type { ClientSockets, FileDescriptor } from "../../src/host-types.ts";
import { descriptor } from "./brands.ts";

/** The listening side of a fake connection, for a test to script. */
export interface Peer {
  /** Waits for the client's next bytes; empty once the client closed. */
  read(signal?: AbortSignal): Promise<Uint8Array>;
  write(bytes: Uint8Array | string): void;
  close(): void;
}

export interface FakeSockets {
  readonly sockets: ClientSockets;
  /** The families of the sockets created, in order. */
  readonly families: string[];
  /** Descriptors closed by the client, in order. */
  readonly closed: number[];
  readonly connected: string[];
  /** Registers a service at `unix:/path` or `tcp:host:port`. */
  listen(address: string, serve: (peer: Peer) => void): void;
}

interface Channel {
  readonly queue: Uint8Array[];
  closed: boolean;
  readonly waiters: (() => void)[];
}

function channel(): Channel {
  return { queue: [], closed: false, waiters: [] };
}

function wake(target: Channel): void {
  for (const resolve of target.waiters.splice(0)) resolve();
}

async function take(source: Channel, count: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  for (;;) {
    signal?.throwIfAborted();
    const first = source.queue[0];
    if (first !== undefined) {
      const chunk = first.slice(0, count);
      if (chunk.length === first.length) source.queue.shift();
      else source.queue[0] = first.slice(count);
      return chunk;
    }
    if (source.closed) return new Uint8Array(0);
    await new Promise<void>((resolve, reject) => {
      source.waiters.push(resolve);
      signal?.addEventListener("abort", () => { reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }, { once: true });
    });
  }
}

export function fakeSockets(options: { readonly maxWrite?: number } = {}): FakeSockets {
  const services = new Map<string, (peer: Peer) => void>();
  const connections = new Map<number, { readonly toServer: Channel; readonly toClient: Channel } | undefined>();
  const families: string[] = [], closed: number[] = [], connected: string[] = [];
  let next = 50;

  const sockets: ClientSockets = {
    socket(family) {
      families.push(family);
      next += 1;
      connections.set(next, undefined);
      return Promise.resolve(descriptor(next));
    },
    async connect(fd, address, connectOptions) {
      connectOptions?.signal?.throwIfAborted();
      const key = address.family === "unix" ? `unix:${address.path}` : `tcp:${address.address}:${String(address.port)}`;
      if (key.endsWith(":9")) {
        // The discard port never answers: the attempt ends only when it is cancelled.
        await new Promise<never>((_resolve, reject) => { connectOptions?.signal?.addEventListener("abort", () => { reject(connectOptions.signal?.reason instanceof Error ? connectOptions.signal.reason : new Error("aborted")); }, { once: true }); });
      }
      const serve = services.get(key);
      if (serve === undefined) throw new LinuxError(address.family === "unix" ? 2 : 111);
      const toServer = channel(), toClient = channel();
      connections.set(fd, { toServer, toClient });
      connected.push(key);
      serve({
        read: signal => take(toServer, 65536, signal),
        write: bytes => { toClient.queue.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes); wake(toClient); },
        close: () => { toClient.closed = true; wake(toClient); },
      });
    },
    address: () => Promise.reject(new LinuxError(38)),
    async read(fd, count, readOptions) {
      const connection = connections.get(fd);
      if (connection === undefined) throw new LinuxError(107);
      return take(connection.toClient, count, readOptions?.signal);
    },
    write(fd, bytes, writeOptions) {
      writeOptions?.signal?.throwIfAborted();
      const connection = connections.get(fd);
      if (connection === undefined) return Promise.reject(new LinuxError(107));
      if (connection.toClient.closed && connection.toServer.closed) return Promise.reject(new LinuxError(32));
      const accepted = bytes.slice(0, options.maxWrite ?? bytes.length);
      connection.toServer.queue.push(accepted);
      wake(connection.toServer);
      return Promise.resolve(accepted.length);
    },
    close(fd) {
      closed.push(fd);
      const connection = connections.get(fd);
      connections.delete(fd);
      if (connection !== undefined) { connection.toServer.closed = true; wake(connection.toServer); }
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
  return { sockets, families, closed, connected, listen: (address, serve) => { services.set(address, serve); } };
}

/** A service that answers every chunk with the same bytes, upper-cased, and notes what it received. */
export function echoUpperCase(log: string[] = []): (peer: Peer) => void {
  return peer => {
    void (async () => {
      for (;;) {
        const bytes = await peer.read().catch(() => new Uint8Array(0));
        if (bytes.length === 0) { peer.close(); return; }
        log.push(new TextDecoder().decode(bytes));
        peer.write(new TextDecoder().decode(bytes).toUpperCase());
      }
    })();
  };
}

export type { FileDescriptor };
