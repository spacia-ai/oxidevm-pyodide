import { LinuxError } from "@oxidevm/sdk/js-process";
import { kit } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_SOCKETS, MAX_RECV_BYTES, socketBridge, SocketFailure } from "../src/socket-bridge.ts";
import type { SocketBridge, SocketHost } from "../src/socket-bridge.ts";
import { echoUpperCase, fakeSockets } from "./support/fake-sockets.ts";
import type { FakeSockets, Peer } from "./support/fake-sockets.ts";

const UNIX = "/workspace/_oxidevm/echo.sock";
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function setup(options: { readonly maxWrite?: number; readonly signal?: AbortSignal; readonly sockets?: SocketHost["sockets"] } = {}): { readonly bridge: SocketBridge; readonly fake: FakeSockets; readonly received: string[] } {
  const fake = fakeSockets(options.maxWrite === undefined ? {} : { maxWrite: options.maxWrite });
  const received: string[] = [];
  fake.listen(`unix:${UNIX}`, echoUpperCase(received));
  fake.listen("tcp:127.0.0.1:5432", echoUpperCase(received));
  fake.listen("tcp:::1:5432", echoUpperCase(received));
  const bridge = socketBridge({ sockets: options.sockets ?? fake.sockets, kit, signal: options.signal ?? new AbortController().signal });
  return { bridge, fake, received };
}

async function failure(work: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SocketFailure);
    return error instanceof SocketFailure ? { code: error.code, message: error.message } : { code: "", message: "" };
  }
  throw new Error("expected a SocketFailure");
}

describe("connecting", () => {
  it("opens a Unix socket, an IPv4 and an IPv6 TCP connection, and hands out increasing handles", async () => {
    const { bridge, fake } = setup();
    expect(await bridge.connect("unix", UNIX, 0, 1000)).toBe(1);
    expect(await bridge.connect("tcp", "127.0.0.1", 5432, 1000)).toBe(2);
    expect(await bridge.connect("tcp", "::1", 5432, 1000)).toBe(3);
    expect(fake.families).toEqual(["unix", "ipv4", "ipv6"]);
    expect(fake.connected).toEqual([`unix:${UNIX}`, "tcp:127.0.0.1:5432", "tcp:::1:5432"]);
  });

  it("names the errno of a refused connection, as the symbolic name Python looks up", async () => {
    const { bridge, fake } = setup();
    expect(await failure(bridge.connect("unix", "/workspace/_oxidevm/missing.sock", 0, 1000))).toEqual({ code: "ENOENT", message: "No such file or directory" });
    expect(await failure(bridge.connect("tcp", "127.0.0.1", 6000, 1000))).toEqual({ code: "ECONNREFUSED", message: "Connection refused" });
    // A failed attempt does not leak its descriptor.
    expect(fake.closed).toHaveLength(2);
  });

  it("refuses requests that are not well formed, without touching the host", async () => {
    const { bridge, fake } = setup();
    const requests: readonly (readonly unknown[])[] = [
      ["pipe", UNIX, 0, 1000], [undefined, UNIX, 0, 1000], ["unix", 7, 0, 1000], ["unix", "", 0, 1000], ["unix", "relative.sock", 0, 1000],
      ["unix", `/${"x".repeat(107)}`, 0, 1000], ["unix", "/tmp/a\0b", 0, 1000],
      ["tcp", "127.0.0.1", 0, 1000], ["tcp", "127.0.0.1", 65536, 1000], ["tcp", "127.0.0.1", 1.5, 1000], ["tcp", "127.0.0.1", "5432", 1000],
      ["tcp", "localhost", 5432, 1000], ["tcp", "example.com", 5432, 1000], ["tcp", "1.2.3", 5432, 1000], ["tcp", "::g", 5432, 1000],
      ["unix", UNIX, 0, -1], ["unix", UNIX, 0, 1.5], ["unix", UNIX, 0, "10"], ["unix", UNIX, 0, 24 * 60 * 60 * 1000 + 1],
    ];
    for (const request of requests) {
      const [kind, target, port, timeout] = request;
      expect((await failure(bridge.connect(kind, target, port, timeout))).code, JSON.stringify(request)).toBe("EINVAL");
    }
    expect(fake.families).toEqual([]);
  });

  it("accepts a Unix path of exactly 107 bytes and refuses one more", async () => {
    const { bridge, fake } = setup();
    const longest = `/${"x".repeat(106)}`;
    fake.listen(`unix:${longest}`, echoUpperCase());
    expect(await bridge.connect("unix", longest, 0, 1000)).toBe(1);
    expect((await failure(bridge.connect("unix", `${longest}x`, 0, 1000))).code).toBe("EINVAL");
    // The limit counts bytes, not characters.
    expect((await failure(bridge.connect("unix", `/${"é".repeat(54)}`, 0, 1000))).code).toBe("EINVAL");
  });

  it("gives up after the connect timeout and reports ETIMEDOUT", async () => {
    const { bridge, fake } = setup();
    expect((await failure(bridge.connect("tcp", "127.0.0.1", 9, 20))).code).toBe("ETIMEDOUT");
    expect(fake.closed).toHaveLength(1);
  });

  it("reports EINTR when the module stops during the attempt", async () => {
    const controller = new AbortController();
    const { bridge } = setup({ signal: controller.signal });
    const pending = failure(bridge.connect("tcp", "127.0.0.1", 9, 0));
    controller.abort(new Error("stopping"));
    expect((await pending).code).toBe("EINTR");
  });

  it("holds at most 32 sockets open at once, and frees a place when one closes", async () => {
    const { bridge } = setup();
    const handles: number[] = [];
    for (let index = 0; index < MAX_OPEN_SOCKETS; index += 1) handles.push(await bridge.connect("unix", UNIX, 0, 1000));
    expect((await failure(bridge.connect("unix", UNIX, 0, 1000))).code).toBe("EMFILE");
    await bridge.close(handles[0]);
    expect(await bridge.connect("unix", UNIX, 0, 1000)).toBe(MAX_OPEN_SOCKETS + 1);
  });

  it("turns an unexpected host failure into EIO and a missing errno into the closest name", async () => {
    const failing = fakeSockets();
    const { bridge } = setup({ sockets: { ...failing.sockets, socket: () => Promise.reject(new Error("host exploded")) } });
    expect(await failure(bridge.connect("unix", UNIX, 0, 1000))).toEqual({ code: "EIO", message: "host exploded" });
    const refusing = setup({ sockets: { ...failing.sockets, socket: () => Promise.reject(new LinuxError(13)) } });
    expect((await failure(refusing.bridge.connect("unix", UNIX, 0, 1000))).code).toBe("EACCES");
  });
});

describe("sending and receiving", () => {
  it("sends bytes the service receives and receives its answer", async () => {
    const { bridge, received } = setup();
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.send(handle, bytes("ping"), 0);
    expect(text(await bridge.recv(handle, 100, 1000))).toBe("PING");
    expect(received).toEqual(["ping"]);
  });

  it("keeps writing until every byte is accepted, however few the host takes at a time", async () => {
    const { bridge, received } = setup({ maxWrite: 3 });
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.send(handle, bytes("0123456789"), 0);
    let collected = "";
    while (collected.length < 10) collected += text(await bridge.recv(handle, 100, 1000));
    expect(collected).toBe("0123456789");
    expect(received.join("")).toBe("0123456789");
  });

  it("returns what is there, at most the size asked for, and nothing at the end of the stream", async () => {
    const { bridge, fake } = setup();
    fake.listen("tcp:127.0.0.1:7000", peer => { peer.write("abcdef"); peer.close(); });
    const handle = await bridge.connect("tcp", "127.0.0.1", 7000, 1000);
    expect(text(await bridge.recv(handle, 4, 1000))).toBe("abcd");
    expect(text(await bridge.recv(handle, 4, 1000))).toBe("ef");
    expect((await bridge.recv(handle, 4, 1000)).length).toBe(0);
  });

  it("limits one receive to 1 MiB and refuses sizes that make no sense", async () => {
    const { bridge } = setup();
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    expect(MAX_RECV_BYTES).toBe(1024 ** 2);
    for (const size of [0, -1, 1.5, MAX_RECV_BYTES + 1, "10", undefined]) expect((await failure(bridge.recv(handle, size, 0))).code, String(size)).toBe("EINVAL");
  });

  it("refuses data that is not bytes", async () => {
    const { bridge } = setup();
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    for (const data of ["text", [1, 2], null, undefined, new ArrayBuffer(2)]) expect((await failure(bridge.send(handle, data, 0))).code).toBe("EINVAL");
  });

  it("reports ETIMEDOUT when nothing arrives in time, and the connection stays usable", async () => {
    const { bridge, fake } = setup();
    fake.listen("tcp:127.0.0.1:7001", peer => { void peer.read().then(() => { peer.write("late"); }); });
    const handle = await bridge.connect("tcp", "127.0.0.1", 7001, 1000);
    expect((await failure(bridge.recv(handle, 10, 20))).code).toBe("ETIMEDOUT");
    await bridge.send(handle, bytes("wake"), 0);
    expect(text(await bridge.recv(handle, 10, 1000))).toBe("late");
  });

  it("reports EINTR when the module stops while it waits", async () => {
    const controller = new AbortController();
    const { bridge, fake } = setup({ signal: controller.signal });
    fake.listen("tcp:127.0.0.1:7002", () => undefined);
    const handle = await bridge.connect("tcp", "127.0.0.1", 7002, 1000);
    const pending = failure(bridge.recv(handle, 10, 0));
    controller.abort(new Error("stopping"));
    expect((await pending).code).toBe("EINTR");
  });

  it("names the errno when the host fails a read or a write", async () => {
    const fake = fakeSockets();
    fake.listen(`unix:${UNIX}`, echoUpperCase());
    const { bridge } = setup({ sockets: { ...fake.sockets, read: () => Promise.reject(new LinuxError(104)), write: () => Promise.reject(new LinuxError(32)) } });
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    expect((await failure(bridge.recv(handle, 10, 0))).code).toBe("ECONNRESET");
    expect((await failure(bridge.send(handle, bytes("x"), 0))).code).toBe("EPIPE");
  });

  it("treats a write that accepts nothing as a broken pipe instead of looping", async () => {
    const fake = fakeSockets();
    fake.listen(`unix:${UNIX}`, echoUpperCase());
    const { bridge } = setup({ sockets: { ...fake.sockets, write: () => Promise.resolve(0) } });
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    expect((await failure(bridge.send(handle, bytes("x"), 0))).code).toBe("EPIPE");
  });
});

describe("closing", () => {
  it("closes the descriptor once, and a second close is harmless", async () => {
    const { bridge, fake } = setup();
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.close(handle);
    await bridge.close(handle);
    expect(fake.closed).toEqual([51]);
  });

  it("refuses to use a closed or unknown handle", async () => {
    const { bridge } = setup();
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.close(handle);
    for (const used of [handle, 99, "1", undefined, -1]) {
      expect((await failure(bridge.send(used, bytes("x"), 0))).code, String(used)).toBe("EBADF");
      expect((await failure(bridge.recv(used, 1, 0))).code, String(used)).toBe("EBADF");
    }
    await expect(bridge.close("1")).resolves.toBeUndefined();
  });

  it("closes every socket that is still open when the program ends", async () => {
    const { bridge, fake } = setup();
    await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.connect("tcp", "127.0.0.1", 5432, 1000);
    const handle = await bridge.connect("unix", UNIX, 0, 1000);
    await bridge.close(handle);
    await bridge.closeAll();
    expect([...fake.closed].sort()).toEqual([51, 52, 53]);
    await bridge.closeAll();
    expect(fake.closed).toHaveLength(3);
  });
});

export type { Peer };
