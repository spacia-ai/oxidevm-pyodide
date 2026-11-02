import { NetError, TlsError } from "@oxidevm/sdk/wasm";
import type { NetHost, NetTlsSession } from "../../src/host-types.ts";

// A deterministic stand-in for `host.net` (engine ADR 0029) that Python's own socket and ssl code can drive
// synchronously: Pyodide's sockets block, so every server here answers as soon as it has a whole request. Names resolve
// from a table; servers are byte handlers by "address:port". TLS is a toy protocol with the engine's interface: the client
// says "HELLO <name>\n", a TLS server answers "WELCOME\n", and from then on bytes pass through unchanged, so that the
// plaintext servers can stand behind it. The certificate failures the engine reports are raised for chosen names.

/** A server: gets the bytes the client sent so far and answers with bytes to send back (or nothing yet). */
export type FakeServer = (received: Uint8Array) => { readonly reply?: Uint8Array; readonly close?: boolean };

export interface FakeNet {
  readonly host: { readonly net: NetHost };
  /** Whether the VM is connected to the internet; while it is not, names and public addresses fail with EPERM. */
  connected: boolean;
  /** Every connection opened, as "address:port". */
  readonly connections: string[];
  /** Every TLS session's server name. */
  readonly sessions: string[];
  /** Sessions not freed yet. */
  readonly open: Set<number>;
  /** Called when a read would wait for a server that has nothing to send; it may throw (EINTR for a Ctrl+C). */
  onBlockedRead: (() => void) | undefined;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const all = new Uint8Array(left.length + right.length);
  all.set(left);
  all.set(right, left.length);
  return all;
}

/** An HTTP/1.1 server that answers every request with `body` and closes. */
export function httpServer(body: string, status = "200 OK"): () => FakeServer {
  return () => received => {
    const text = decoder.decode(received);
    if (!text.includes("\r\n\r\n")) return {};
    const payload = encoder.encode(body);
    return { reply: concat(encoder.encode(`HTTP/1.1 ${status}\r\nContent-Length: ${String(payload.length)}\r\nConnection: close\r\nX-Request-Line: ${text.split("\r\n")[0] ?? ""}\r\n\r\n`), payload), close: true };
  };
}

/** The toy TLS server in front of `inner`: answers the hello with "WELCOME\n", then passes the bytes through. */
export function tlsServer(inner: () => FakeServer): () => FakeServer {
  return () => {
    const plain = inner();
    let greeted = false;
    return received => {
      if (greeted) return plain(received);
      const text = decoder.decode(received), end = text.indexOf("\n");
      if (!text.startsWith("HELLO ") || end === -1) return {};
      greeted = true;
      const rest = received.subarray(end + 1), answer = rest.length === 0 ? {} : plain(rest);
      return { reply: concat(encoder.encode("WELCOME\n"), answer.reply ?? new Uint8Array()), ...(answer.close === true ? { close: true } : {}) };
    };
  };
}

const FAILURES: Readonly<Record<string, ConstructorParameters<typeof TlsError>[0]>> = {
  "untrusted.test": "unknown-issuer", "wrong-name.test": "name-mismatch", "expired.test": "certificate-expired", "self-signed.test": "bad-certificate",
};

function isPrivate(address: string): boolean {
  return address.startsWith("127.") || address.startsWith("10.") || address === "::1";
}

export function fakeNet(names: Readonly<Record<string, readonly string[]>>, servers: Readonly<Record<string, () => FakeServer>>): FakeNet {
  const connections: string[] = [], sessionNames: string[] = [], open = new Set<number>();
  let nextSession = 1;
  const state: FakeNet = {
    connections, sessions: sessionNames, open, connected: true, onBlockedRead: undefined,
    host: {
      net: {
        resolve: () => Promise.reject(new Error("the fake network is synchronous")),
        connect: () => Promise.reject(new Error("the fake network is synchronous")),
        resolveSync: name => {
          if (!state.connected && name !== "localhost") throw new NetError("EPERM", `getaddrinfo ${name}: this VM is not connected to the internet`, { reason: "vm-local-only", errno: 1, hostname: name });
          if (name === "slow.test") throw new NetError("EAI_AGAIN", `getaddrinfo ${name}: the VM's nameserver did not answer`, { hostname: name });
          const found = names[name];
          if (found === undefined) throw new NetError("ENOTFOUND", `getaddrinfo ${name}: not found`, { hostname: name });
          return found;
        },
        connectSync: options => {
          const key = `${options.host}:${String(options.port)}`;
          if (!state.connected && !isPrivate(options.host)) throw new NetError("EPERM", `connect ${key}: this VM is not connected to the internet`, { reason: "vm-local-only", errno: 1 });
          const start = servers[key];
          if (start === undefined) throw new NetError("ECONNREFUSED", `connect ${key}: the connection was refused`, { errno: 111 });
          connections.push(key);
          const server = start();
          let received: Uint8Array = new Uint8Array(), pending: Uint8Array = new Uint8Array(), closed = false;
          return {
            alpn: null,
            write: bytes => {
              received = concat(received, bytes);
              const answer = server(received);
              if (answer.reply !== undefined) { pending = concat(pending, answer.reply); received = new Uint8Array(); }
              if (answer.close === true) closed = true;
            },
            read: max => {
              if (pending.length === 0) {
                if (closed) return new Uint8Array();
                state.onBlockedRead?.();
                throw new NetError("ETIMEDOUT", `read ${key}: the fake server has nothing to send`);
              }
              const chunk = pending.slice(0, max);
              pending = pending.slice(max);
              return chunk;
            },
            closeWrite: () => undefined,
            close: () => { closed = true; },
          };
        },
        tls: options => {
          sessionNames.push(options.serverName);
          const id = nextSession++;
          open.add(id);
          let status: ReturnType<NetTlsSession["state"]> = "handshaking", toPeer: Uint8Array = encoder.encode(`HELLO ${options.serverName}\n`), plaintext: Uint8Array = new Uint8Array();
          return {
            receive: bytes => {
              if (status === "handshaking") {
                const failure = FAILURES[options.serverName];
                if (failure !== undefined) { status = "failed"; throw new TlsError(failure, options.serverName); }
                const text = decoder.decode(bytes);
                if (!text.startsWith("WELCOME\n")) { status = "failed"; throw new TlsError("protocol", options.serverName); }
                status = "established";
                plaintext = concat(plaintext, bytes.subarray("WELCOME\n".length));
                return;
              }
              plaintext = concat(plaintext, bytes);
            },
            takeTls: () => { const out = toPeer; toPeer = new Uint8Array(); return out; },
            send: bytes => { toPeer = concat(toPeer, bytes); },
            takePlaintext: max => { const chunk = plaintext.slice(0, max); plaintext = plaintext.slice(max); return chunk; },
            state: () => status,
            alpn: () => (status === "established" ? options.alpn?.[0] ?? null : null),
            close: () => { status = "closed"; },
            free: () => { open.delete(id); },
          };
        },
      },
    },
  };
  return state;
}
