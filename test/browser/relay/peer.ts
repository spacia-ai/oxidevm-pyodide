// Copied from oxidevm-sdk (Apache-2.0) tests/browser/relay-test-peer.ts at 02fac09296cac393ef97371b1fe70145000f9d3f, for the
// internet scenarios of this module (test/browser/harness.ts --internet). Keep it in step with the SDK's copy.
// A relay v2 test peer for browser experiments (engine spec/relay/v2.md), in place of a personal or operator relay. It
// issues operator-style tickets (POST /v2/sessions), authenticates the WebSocket, and carries TCP streams and controlled
// DNS the way the native relay does: per-stream sequences, credit returned only after the upstream write completes,
// HALF_CLOSE and RESET. Instead of the internet, a TCP stream goes to a local server chosen by its public address and
// port, and DNS is answered from a fixed table, so nothing leaves the machine. It keeps the destination list the native
// relay shows on its control page (crates/oxidevm-relay/src/destinations.rs): queried names, TCP destinations named by
// the answer that led to them, connections and bytes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { decodeRelayFrame, encodeRelayFrame, RelayKind, type RelayFrame } from "../../../node_modules/@oxidevm/sdk/dist/runtime/workers/relay-wire.js";
import { answerDns, type DnsTable } from "./dns.ts";
import { acceptWebSocket, type WebSocketPeer } from "./websocket.ts";

/** A public address the peer pretends to reach, and the local port each relay port of it goes to. */
export interface RelayRoute { readonly address: string; readonly ports: ReadonlyMap<number, number> }
export interface RelayDestination {
  /** The name the peer's DNS answered for this address, or the address when it answered none. */
  name: string;
  readonly address: string | null;
  readonly port: number;
  readonly kind: "tcp" | "dns";
  connections: number;
  bytesUp: number;
  bytesDown: number;
}
export interface RelayTestPeer {
  /** The relay endpoint for `vm.network.connect({ kind: "server", url })`. */
  readonly url: string;
  /** The destination list, most recently used last. */
  destinations(): readonly RelayDestination[];
  /** The Origin of every authenticated relay WebSocket, in order. */
  readonly origins: readonly string[];
  /** Revocations: by the browser (POST /v2/revoke) and by this peer (`revokeAll`, the control page's revoke). */
  readonly revocations: { browser: number; peer: number };
  /** Ends every authenticated session from the relay side, as the control page's revoke does. */
  revokeAll(): number;
  close(): Promise<void>;
}

const INITIAL_CREDIT = 131072, MAX_PAYLOAD = 65536, TICKET_MS = 30_000, SESSION_MS = 3_600_000;
const EMPTY = new Uint8Array();

interface Stream {
  readonly id: bigint;
  readonly kind: "tcp" | "dns";
  readonly key: string;
  out: bigint;
  incoming: bigint;
  /** What the browser still accepts from us. */
  credit: number;
  readonly pending: Uint8Array[];
  socket: Socket | undefined;
  upstreamEnded: boolean;
  halfClosed: boolean;
}
interface Ticket { readonly workspaceId: string; readonly browserSessionId: string; readonly origin: string; readonly expiresAt: number }

/** Serves the relay over HTTPS and WSS with `identity`, as an operator relay is deployed. */
export async function startRelayTestPeer(identity: { readonly key: string; readonly cert: string }, routes: readonly RelayRoute[], dns: DnsTable): Promise<RelayTestPeer> {
  const tickets = new Map<string, Ticket>(), sessions = new Set<{ readonly identity: Ticket; end(): void }>();
  const table = new Map<string, RelayDestination>(), names = new Map<string, string>(), origins: string[] = [];
  const revocations = { browser: 0, peer: 0 };
  let nextSession = 1n;
  const touch = (key: string, make: () => RelayDestination): RelayDestination => {
    const entry = table.get(key) ?? make();
    table.delete(key); table.set(key, entry);
    return entry;
  };
  const server = createServer({ key: identity.key, cert: identity.cert }, (request, response) => { void http(request, response).catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); }); });
  const cors = (request: IncomingMessage, response: ServerResponse): void => {
    const origin = request.headers.origin;
    if (typeof origin === "string") response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  };
  async function http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    cors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Private-Network": "true" }).end();
      return;
    }
    if (request.method !== "POST" || (path !== "/v2/sessions" && path !== "/v2/revoke")) { response.writeHead(404).end(); return; }
    const body = await readJson(request);
    const origin = request.headers.origin;
    assert(typeof origin === "string", "the browser sends an Origin");
    if (path === "/v2/revoke") {
      const workspaceId: unknown = Reflect.get(body, "workspaceId"), browserSessionId: unknown = Reflect.get(body, "browserSessionId");
      for (const session of sessions) if (session.identity.workspaceId === workspaceId && session.identity.browserSessionId === browserSessionId) session.end();
      revocations.browser += 1;
      response.writeHead(204).end();
      return;
    }
    assert.deepEqual(Object.keys(body).sort(), ["browserSessionId", "origin", "version", "workspaceId"], "a session request has exactly its fields");
    const workspaceId: unknown = Reflect.get(body, "workspaceId"), browserSessionId: unknown = Reflect.get(body, "browserSessionId");
    assert(Reflect.get(body, "version") === 2 && typeof workspaceId === "string" && typeof browserSessionId === "string" && Reflect.get(body, "origin") === origin, "a session request names this browser and origin");
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, { workspaceId, browserSessionId, origin, expiresAt: Date.now() + TICKET_MS });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: 2, webSocketUrl: `wss://127.0.0.1:${String(port())}/v2/socket`, ticket, expiresAt: Date.now() + TICKET_MS }));
  }
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== "/v2/socket" || request.headers["sec-websocket-protocol"] !== "oxidevm-relay-v2") { socket.destroy(); return; }
    let session: ReturnType<typeof relaySession> | undefined;
    const peer = acceptWebSocket(request, socket, head, "oxidevm-relay-v2", {
      text: (message) => {
        const input: unknown = JSON.parse(message);
        assert(session === undefined && typeof input === "object" && input !== null, "one authentication message");
        const ticket = tickets.get(String(Reflect.get(input, "ticket")));
        tickets.delete(String(Reflect.get(input, "ticket")));
        if (ticket === undefined || ticket.expiresAt < Date.now() || ticket.origin !== request.headers.origin || Reflect.get(input, "workspaceId") !== ticket.workspaceId || Reflect.get(input, "browserSessionId") !== ticket.browserSessionId) {
          peer.text(JSON.stringify({ version: 2, reason: "authentication-failed" })); peer.close(); return;
        }
        origins.push(ticket.origin);
        const id = nextSession++;
        session = relaySession(id, peer);
        const entry = { identity: ticket, end: () => { session?.end(); peer.close(); sessions.delete(entry); } };
        sessions.add(entry);
        peer.closed.then(() => { session?.end(); sessions.delete(entry); }, () => undefined);
        peer.text(JSON.stringify({ version: 2, sessionId: id.toString(), expiresAt: Date.now() + SESSION_MS }));
      },
      binary: (payload) => { assert(session !== undefined, "no binary frame before authentication"); session.frame(payload); },
    });
  });

  /** One authenticated session: its streams, until the socket closes or it is revoked. */
  function relaySession(id: bigint, peer: WebSocketPeer) {
    const streams = new Map<bigint, Stream>(), retired = new Map<bigint, bigint>();
    let ended = false, lastStream = 0n;
    /** One frame on `stream`, numbered in its sequence; a PONG (no stream) carries the sequence of the PING it answers. */
    const send = (kind: number, stream: Stream | bigint, payload: Uint8Array, window: number): void => {
      if (ended) return;
      const [streamId, sequence] = typeof stream === "bigint" ? [0n, stream] : [stream.id, stream.out++];
      peer.binary(new Uint8Array(encodeRelayFrame({ kind, session: id, stream: streamId, sequence, payload, window })));
    };
    const retire = (stream: Stream): void => { streams.delete(stream.id); retired.set(stream.id, stream.incoming); stream.socket?.destroy(); };
    const reset = (stream: Stream, reason: string): void => { send(RelayKind.RESET, stream, new TextEncoder().encode(reason), 0); retire(stream); };
    const flush = (stream: Stream): void => {
      while (stream.pending[0] !== undefined && stream.credit > 0 && streams.has(stream.id)) {
        const head = stream.pending[0], length = Math.min(head.byteLength, stream.credit, MAX_PAYLOAD);
        send(RelayKind.DATA, stream, head.subarray(0, length), 0);
        stream.credit -= length;
        if (length === head.byteLength) stream.pending.shift(); else stream.pending[0] = head.subarray(length);
        const entry = table.get(stream.key);
        if (entry !== undefined) entry.bytesDown += length;
      }
      const buffered = stream.pending.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      if (stream.socket !== undefined) { if (buffered > INITIAL_CREDIT) stream.socket.pause(); else stream.socket.resume(); }
      if (buffered === 0 && stream.upstreamEnded && !stream.halfClosed && streams.has(stream.id)) { stream.halfClosed = true; send(RelayKind.HALF_CLOSE, stream, Uint8Array.of(1), 0); }
    };
    const open = (frame: RelayFrame): void => {
      assert(frame.stream > lastStream && frame.sequence === 0n, "streams are new, increasing and start at sequence 0");
      lastStream = frame.stream;
      const transport = frame.payload[0], family = frame.payload[1], view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 20);
      const relayPort = view.getUint16(2, false), address = family === 2 ? [...frame.payload.subarray(4, 8)].join(".") : "ipv6";
      const kind = transport === 17 ? "dns" : "tcp";
      const stream: Stream = { id: frame.stream, kind, key: kind === "dns" ? "" : `tcp ${address}:${String(relayPort)}`, out: 0n, incoming: 1n, credit: frame.window, pending: [], socket: undefined, upstreamEnded: false, halfClosed: false };
      streams.set(stream.id, stream);
      if (kind === "dns") { assert(relayPort === 53, "DNS goes to port 53"); send(RelayKind.OPENED, stream, EMPTY, INITIAL_CREDIT); return; }
      const local = routes.find(route => route.address === address)?.ports.get(relayPort);
      const entry = touch(stream.key, () => ({ name: names.get(address) ?? address, address, port: relayPort, kind: "tcp", connections: 0, bytesUp: 0, bytesDown: 0 }));
      entry.connections += 1;
      if (local === undefined) { reset(stream, "host-unreachable"); return; }
      const socket = connect(local, "127.0.0.1");
      stream.socket = socket;
      socket.once("connect", () => { if (streams.has(stream.id)) send(RelayKind.OPENED, stream, EMPTY, INITIAL_CREDIT); });
      socket.on("data", (chunk: Buffer) => { stream.pending.push(new Uint8Array(chunk)); flush(stream); });
      socket.once("end", () => { stream.upstreamEnded = true; flush(stream); });
      socket.once("error", () => { if (streams.has(stream.id)) reset(stream, socket.connecting ? "connection-refused" : "connection-reset"); });
    };
    const data = (stream: Stream, payload: Uint8Array): void => {
      if (stream.kind === "dns") {
        const { reply, name, addresses } = answerDns(payload, dns);
        if (name !== undefined) {
          for (const address of addresses) {
            names.set(address, name);
            for (const entry of table.values()) if (entry.kind === "tcp" && entry.address === address) entry.name = name;
          }
          const entry = touch(`dns ${name}`, () => ({ name, address: null, port: 53, kind: "dns", connections: 0, bytesUp: 0, bytesDown: 0 }));
          entry.connections += 1; entry.bytesUp += payload.byteLength; entry.bytesDown += reply.byteLength;
        }
        if (reply.byteLength <= stream.credit) { stream.credit -= reply.byteLength; send(RelayKind.DATA, stream, reply, 0); }
        send(RelayKind.WINDOW, stream, EMPTY, payload.byteLength);
        return;
      }
      const entry = table.get(stream.key);
      if (entry !== undefined) entry.bytesUp += payload.byteLength;
      stream.socket?.write(payload, () => { if (streams.has(stream.id)) send(RelayKind.WINDOW, stream, EMPTY, payload.byteLength); });
    };
    return {
      frame(bytes: Uint8Array): void {
        const frame = decodeRelayFrame(bytes.slice().buffer, id);
        if (frame.kind === RelayKind.PING) { send(RelayKind.PONG, frame.sequence, EMPTY, 0); return; }
        if (frame.kind === RelayKind.OPEN) { open(frame); return; }
        const stream = streams.get(frame.stream);
        if (stream === undefined) {
          // A stream this peer already reset: the browser may still send correctly sequenced frames for it.
          const expected = retired.get(frame.stream);
          assert(expected === frame.sequence, "frames of a closed stream stay in sequence");
          retired.set(frame.stream, expected + 1n);
          return;
        }
        assert(frame.sequence === stream.incoming, `stream ${String(stream.id)} frames stay in sequence`);
        stream.incoming += 1n;
        switch (frame.kind) {
          case RelayKind.DATA: data(stream, frame.payload); break;
          case RelayKind.WINDOW: stream.credit += frame.window; flush(stream); break;
          case RelayKind.HALF_CLOSE: if (frame.payload[0] !== 0) stream.socket?.end(); break;
          case RelayKind.RESET: retire(stream); break;
          default: throw new Error(`unexpected relay frame kind ${String(frame.kind)}`);
        }
      },
      end(): void {
        if (ended) return;
        ended = true;
        for (const stream of streams.values()) stream.socket?.destroy();
        streams.clear();
      },
    };
  }

  await new Promise<void>((ready, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ready); });
  function port(): number { const address = server.address(); assert(address !== null && typeof address !== "string"); return address.port; }
  return {
    url: `https://127.0.0.1:${String(port())}/`,
    destinations: () => [...table.values()],
    origins,
    revocations,
    revokeAll: () => { const count = sessions.size; for (const session of [...sessions]) session.end(); revocations.peer += count; return count; },
    close: () => new Promise<void>(done => { for (const session of [...sessions]) session.end(); server.close(() => { done(); }); server.closeAllConnections(); }),
  };
}

async function readJson(request: IncomingMessage): Promise<object> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) { assert(Buffer.isBuffer(chunk)); length += chunk.byteLength; assert(length <= 8192, "relay JSON bodies are at most 8 KiB"); chunks.push(chunk); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert(typeof value === "object" && value !== null && !Array.isArray(value), "a JSON object");
  return value;
}

