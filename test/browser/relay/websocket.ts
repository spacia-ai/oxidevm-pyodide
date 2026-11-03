// Copied from oxidevm-sdk (Apache-2.0) tests/browser/websocket-test-frames.ts at 02fac09296cac393ef97371b1fe70145000f9d3f, for the
// internet scenarios of this module (test/browser/harness.ts --internet). Keep it in step with the SDK's copy.
// The server side of RFC 6455 for browser experiments: the handshake, masked client frames (fragments, ping, close) and
// unmasked server frames of any length. Used by the relay test peer and by local wss echo servers; no dependency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface WebSocketHandlers {
  readonly text?: (message: string) => void;
  readonly binary?: (payload: Uint8Array) => void;
}
export interface WebSocketPeer {
  text(message: string): void;
  binary(payload: Uint8Array): void;
  /** Sends a close frame and ends the connection. */
  close(code?: number): void;
  /** Settles when the connection has closed, for whatever reason. */
  readonly closed: Promise<void>;
}

const MAX_MESSAGE = 1024 * 1024;

/**
 * Completes the handshake of `request` (offering `protocol` when given) and delivers each message to `handlers`; `head` is
 * what arrived with the upgrade.
 */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, protocol: string | undefined, handlers: WebSocketHandlers): WebSocketPeer {
  const key = request.headers["sec-websocket-key"];
  assert(typeof key === "string" && request.headers.upgrade?.toLowerCase() === "websocket", "a WebSocket upgrade");
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol === undefined ? "" : `Sec-WebSocket-Protocol: ${protocol}\r\n`}\r\n`);
  const closed = Promise.withResolvers<undefined>();
  let open = true;
  socket.once("close", () => { open = false; closed.resolve(undefined); });
  socket.on("error", () => { socket.destroy(); });
  const frame = (opcode: number, payload: Uint8Array): void => {
    if (!open) return;
    const length = payload.byteLength;
    const head = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
    socket.write(Buffer.concat([head, payload]));
  };
  const peer: WebSocketPeer = {
    text: message => { frame(1, new TextEncoder().encode(message)); },
    binary: payload => { frame(2, payload); },
    close: (code = 1000) => { if (!open) return; frame(8, Uint8Array.of(code >> 8, code & 0xff)); open = false; socket.end(); },
    closed: closed.promise,
  };
  let buffered: Buffer = Buffer.alloc(0), fragments: Buffer[] = [], fragmentOpcode = 0;
  const deliver = (opcode: number, payload: Buffer): void => {
    if (opcode === 8) { peer.close(payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1000); return; }
    if (opcode === 9) { frame(10, payload); return; }
    if (opcode === 10) return;
    if (opcode === 1) handlers.text?.(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    else if (opcode === 2) handlers.binary?.(new Uint8Array(payload));
    else throw new Error(`unexpected WebSocket opcode ${String(opcode)}`);
  };
  const receive = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.byteLength < 2) return;
      const first = buffered.readUInt8(0), second = buffered.readUInt8(1);
      assert((second & 0x80) !== 0, "client frames are masked");
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (buffered.byteLength < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffered.byteLength < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
      assert(length <= MAX_MESSAGE, "WebSocket frames stay bounded");
      if (buffered.byteLength < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4), payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.byteLength; index++) payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
      buffered = buffered.subarray(offset + 4 + length);
      const opcode = first & 0x0f, fin = (first & 0x80) !== 0;
      if (opcode >= 8) { deliver(opcode, payload); continue; }
      if (opcode !== 0) fragmentOpcode = opcode;
      fragments.push(payload);
      assert(fragments.reduce((sum, part) => sum + part.byteLength, 0) <= MAX_MESSAGE, "WebSocket messages stay bounded");
      if (fin) { const message = Buffer.concat(fragments); fragments = []; deliver(fragmentOpcode, message); }
    }
  };
  const onData = (chunk: unknown): void => {
    try { assert(Buffer.isBuffer(chunk)); receive(chunk); }
    catch (error: unknown) { process.stderr.write(`websocket: ${error instanceof Error ? error.message : String(error)}\n`); peer.close(1002); }
  };
  socket.on("data", onData);
  if (head.byteLength > 0) queueMicrotask(() => { onData(head); });
  return peer;
}
