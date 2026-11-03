import { describe, expect, it } from "vitest";
import { MAX_RECEIVE_TIMEOUT_MS, netBridge, receiveTimeoutMs } from "../src/net-bridge.ts";
import { certificatesOf } from "../src/trust.ts";
import type { EmscriptenSockets } from "../src/host-types.ts";
import { WHEELS } from "../src/shipped.ts";
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

describe("the authorities a program adds", () => {
  const pem = (...marks: string[]): Uint8Array => new TextEncoder().encode(marks.map(mark => `# ${mark}\n-----BEGIN CERTIFICATE-----\n${btoa(mark)}\n-----END CERTIFICATE-----\n`).join(""));
  function trusting(store: Uint8Array | undefined): { readonly net: ReturnType<typeof netBridge>; readonly given: (readonly string[])[]; readonly reads: number[] } {
    const fake = fakeNet({}, {}), given: (readonly string[])[] = [], reads: number[] = [];
    const tls = (options: Parameters<typeof fake.host.net.tls>[0]): ReturnType<typeof fake.host.net.tls> => fake.host.net.tls(options);
    const net = netBridge({ net: { ...fake.host.net, tls: options => { given.push((options.trust ?? []).map(entry => new TextDecoder().decode(entry))); return tls(options); } } }, () => 5, () => { reads.push(1); return store; });
    return { net, given, reads };
  }

  it("passes each certificate the VM's store lacks once, as DER, and reads the store only once", () => {
    const { net, given, reads } = trusting(pem("vm-one", "vm-two"));
    expect(net.tlsOpen("a.test", [], [pem("vm-one", "extra-one", "extra-one"), Uint8Array.of(0x30, 0x01)]).ok).toBe(true);
    expect(net.tlsOpen("a.test", [], []).ok).toBe(true);
    expect(net.tlsOpen("a.test", [], [pem("vm-two")]).ok).toBe(true);
    expect(given).toEqual([["extra-one", "0\u0001"], [], []]);
    expect(reads).toEqual([1]);
  });

  it("refuses more than the engine takes, and bytes that are not bytes", () => {
    const { net } = trusting(undefined);
    const many = pem(...Array.from({ length: 513 }, (_, index) => `authority ${String(index)}`));
    const refusedMany = net.tlsOpen("a.test", [], [many]);
    expect(refusedMany).toMatchObject({ ok: false, code: "ERR_TLS_INVALID_TRUST" });
    expect(refusedMany.ok ? "" : refusedMany.message).toContain("the program added 513 authorities");
    const large = Array.from({ length: 3 }, (_, index) => new Uint8Array(800 * 1024).fill(index + 1));
    expect(net.tlsOpen("a.test", [], large)).toMatchObject({ ok: false, code: "ERR_TLS_INVALID_TRUST" });
    expect(net.tlsOpen("a.test", [], ["text"])).toMatchObject({ ok: false, code: "EINVAL" });
    // A block that is not base64 stays PEM text, for the engine to refuse.
    expect(certificatesOf(new TextEncoder().encode("-----BEGIN CERTIFICATE-----\n%%%\n-----END CERTIFICATE-----\n")).map(entry => new TextDecoder().decode(entry))).toEqual(["-----BEGIN CERTIFICATE-----\n%%%\n-----END CERTIFICATE-----"]);
  });
});

describe("requests' default authorities", () => {
  it("loads certifi's whole bundle (120 certificates) without ERR_TLS_INVALID_TRUST, even when the VM's store has none of it", async () => {
    const { execFileSync } = await import("node:child_process");
    const certifi = Uint8Array.from(execFileSync("unzip", ["-p", `upstream/${WHEELS.certifi}`, "certifi/cacert.pem"]));
    const given: number[] = [];
    const fake = fakeNet({}, {});
    const tls = (options: Parameters<typeof fake.host.net.tls>[0]): ReturnType<typeof fake.host.net.tls> => { given.push(options.trust?.length ?? 0); return fake.host.net.tls(options); };
    const empty = netBridge({ net: { ...fake.host.net, tls } }, () => 5, () => undefined);
    expect(empty.tlsOpen("a.test", [], [certifi])).toMatchObject({ ok: true });
    const covering = netBridge({ net: { ...fake.host.net, tls } }, () => 5, () => certifi);
    expect(covering.tlsOpen("a.test", [], [certifi])).toMatchObject({ ok: true });
    expect(given).toEqual([certificatesOf(certifi).length, 0]);
    expect(certificatesOf(certifi).length).toBeGreaterThan(64);
  });
});
