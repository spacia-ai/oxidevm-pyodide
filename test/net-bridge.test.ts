import { describe, expect, it } from "vitest";
import { MAX_RECEIVE_TIMEOUT_MS, netBridge, receiveTimeoutMs } from "../src/net-bridge.ts";
import type { EmscriptenSockets } from "../src/host-types.ts";
import { fakeNet, httpServer, tlsServer } from "./support/fake-net.ts";

// The parts of the bridge that Python reaches only in edge cases; test/network.test.ts drives the rest from Python.

function bridge(): { readonly net: ReturnType<typeof netBridge>; readonly timeouts: [number, number | null][] } {
  const fake = fakeNet({ "example.test": ["93.184.216.34"] }, { "93.184.216.34:443": tlsServer(httpServer("hello")) }, { certificates: [Uint8Array.of(0x30, 0x00)], version: "TLSv1.2", suite: 0xc02f });
  const timeouts: [number, number | null][] = [];
  const net = netBridge(fake.host, () => 5);
  const sockets: EmscriptenSockets = { receiveTimeout: (fd, ms) => { if (fd === 99) throw new Error("not a socket"); timeouts.push([fd, ms]); } };
  net.attachSockets(sockets);
  return { net, timeouts };
}

describe("receiveTimeoutMs", () => {
  it("turns Python's seconds into whole milliseconds from 1 to a day, None into blocking, and refuses anything else", () => {
    expect([null, undefined, 0, 0.0001, 0.2, 0.2001, 1e9].map(receiveTimeoutMs)).toEqual([null, null, 1, 1, 200, 201, MAX_RECEIVE_TIMEOUT_MS]);
    for (const refused of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", true]) expect(receiveTimeoutMs(refused)).toBeUndefined();
  });
});

describe("netBridge", () => {
  it("sets receive timeouts once Pyodide's sockets are attached, and reports a refusal as an outcome", () => {
    const { net, timeouts } = bridge();
    expect(net.receiveTimeout(7, 0.25)).toEqual({ ok: true, value: null });
    expect(net.receiveTimeout(7, null)).toEqual({ ok: true, value: null });
    expect(timeouts).toEqual([[7, 250], [7, null]]);
    expect(net.receiveTimeout("7", 1)).toMatchObject({ ok: false, code: "EINVAL" });
    expect(net.receiveTimeout(7, -1)).toMatchObject({ ok: false, code: "EINVAL" });
    expect(net.receiveTimeout(99, 1)).toMatchObject({ ok: false, code: "EIO", message: "not a socket" });
    const unattached = netBridge(fakeNet({}, {}).host, () => 5);
    expect(unattached.receiveTimeout(7, 1)).toMatchObject({ ok: false, code: "ENOTSOCK" });
  });

  it("reports the peer's version, cipher and chain once the handshake is done, and nothing before", () => {
    const { net } = bridge();
    const opened = net.tlsOpen("example.test", []);
    if (!opened.ok) throw new Error(opened.message);
    const handle = opened.value;
    expect(net.tlsPeer(handle)).toEqual({ ok: true, value: JSON.stringify({ version: null, cipher: null, chain: 0 }) });
    expect(net.tlsPeerCertificate(handle)).toEqual({ ok: true, value: new Uint8Array() });
    net.tlsReceive(handle, new TextEncoder().encode("WELCOME\n"));
    expect(net.tlsPeer(handle)).toEqual({ ok: true, value: JSON.stringify({ version: "TLSv1.2", cipher: ["ECDHE-RSA-AES128-GCM-SHA256", "TLSv1.2", 128], chain: 1 }) });
    expect(net.tlsPeerCertificate(handle)).toEqual({ ok: true, value: Uint8Array.of(0x30, 0x00) });
    expect(net.tlsPeer(12345)).toMatchObject({ ok: false, code: "EBADF" });
  });

  it("decodes a certificate, or says why it cannot", () => {
    const { net } = bridge();
    expect(net.decodeCertificate("not bytes")).toMatchObject({ ok: false, code: "EINVAL" });
    expect(net.decodeCertificate(Uint8Array.of(0x30, 0x00))).toMatchObject({ ok: false, code: "EIO", message: "the certificate has no to-be-signed part" });
  });
});
