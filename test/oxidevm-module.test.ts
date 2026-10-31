import { LinuxError } from "@oxidevm/sdk/js-process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echoUpperCase } from "./support/fake-sockets.ts";
import type { Child } from "./support/fake-process.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture } from "./support/guest-fixture.ts";

// The Python module `oxidevm`, used the way a program uses it, in the real Pyodide against fakes of the VM's processes and
// sockets. (The same module is exercised against the real engine in test/browser.)

const children = new Map<string, Child>();
let guest: GuestFixture;
const UNIX = "/workspace/_oxidevm/echo.sock";

beforeAll(async () => {
  guest = await startGuest(argv => children.get(argv.join(" ")) ?? {});
  guest.sockets.listen(`unix:${UNIX}`, echoUpperCase());
  guest.sockets.listen("tcp:127.0.0.1:5432", echoUpperCase());
  guest.sockets.listen("tcp:::1:5432", echoUpperCase());
  guest.sockets.listen("tcp:127.0.0.1:7000", peer => { peer.write("hello"); peer.close(); });
  guest.sockets.listen("tcp:127.0.0.1:7001", () => undefined);
});
afterAll(async () => { await guest.stop(); await guest.dispose(); });

/** Runs `body` as a Python program and returns the text it printed; the program must succeed. */
async function printed(body: string): Promise<string> {
  const result = await guest.run(`import errno, oxidevm\nfrom pyodide.ffi import JsException\n${body}`);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("oxidevm.run", () => {
  it("starts a native program and returns what it printed, how it ended, and its process id", async () => {
    children.set("/bin/uname -m", { stdout: "x86_64\n" });
    const before = guest.process.spawned.length;
    expect(await printed('result = oxidevm.run(["/bin/uname", "-m"])\nprint(result.pid, result.returncode, repr(result.stdout), repr(result.stderr))')).toBe(`${String(1000 + before)} 0 'x86_64\\n' ''\n`);
    expect(guest.process.spawned.at(-1)).toMatchObject({ command: "/bin/uname", args: ["-m"], cwd: "/workspace" });
  });

  it("works as `from oxidevm import run` and documents itself", async () => {
    children.set("/bin/true", {});
    expect(await printed('from oxidevm import run\nprint(run(["/bin/true"]).returncode)\nprint(oxidevm.run.__doc__.splitlines()[0])\nprint(oxidevm.__file__.endswith("oxidevm.py"), sorted(oxidevm.__all__))'))
      .toBe("0\nRun a native Linux program, wait for it, and return what it did.\nTrue ['Connection', 'connect_tcp', 'connect_unix', 'run']\n");
  });

  it("raises RuntimeError with the start of standard error when a program fails, unless check is false", async () => {
    children.set("/bin/sh -c exit 7", { stdout: "out", stderr: "boom", exit: { kind: "exited", code: 7 } });
    expect(await printed(`
try:
    oxidevm.run(["/bin/sh", "-c", "exit 7"])
except RuntimeError as error:
    print("raised:", error)
failed = oxidevm.run(["/bin/sh", "-c", "exit 7"], check=False)
print((failed.stdout, failed.stderr, failed.returncode))
`)).toBe("raised: Native command exited 7: boom\n('out', 'boom', 7)\n");
  });

  it("treats a program that a signal ended as failed, with minus the signal number as its return code", async () => {
    children.set("/bin/crash", { stderr: "Segmentation fault", exit: { kind: "signaled", signal: null, signalNumber: 11 } });
    expect(await printed(`
try:
    oxidevm.run(["/bin/crash"])
except RuntimeError as error:
    print("raised:", error)
print(oxidevm.run(["/bin/crash"], check=False).returncode)
`)).toBe("raised: Native command exited -11: Segmentation fault\n-11\n");
  });

  it("cuts standard error in the message at 4096 characters", async () => {
    children.set("/bin/noisy", { stderr: "e".repeat(5000), exit: { kind: "exited", code: 1 } });
    expect(await printed('try:\n    oxidevm.run(["/bin/noisy"])\nexcept RuntimeError as error:\n    print(len(str(error)))')).toBe(`${String("Native command exited 1: ".length + 4096)}\n`);
  });

  it("sends the input text to the program's standard input", async () => {
    children.set("/bin/cat", { stdout: "echoed" });
    await printed('oxidevm.run(["/bin/cat"], input="typed " + "é" * 3)');
    expect(guest.process.spawned.at(-1)?.input).toBe("typed ééé");
  });

  it("kills a program that outlives its timeout and raises an error that says so", async () => {
    children.set("/bin/sh -c while :; do :; done", { hang: true });
    const count = guest.process.spawned.length;
    expect(await printed(`
try:
    oxidevm.run(["/bin/sh", "-c", "while :; do :; done"], timeout=0.03)
except Exception as error:
    print(type(error).__name__, "timed out" in str(error))
`)).toBe("JsException True\n");
    expect(guest.process.spawned.slice(count).map(child => child.signals)).toEqual([[9]]);
  });

  it("refuses output beyond 1 MiB and kills the program", async () => {
    children.set("/bin/head -c 1100000 /dev/zero", { stdout: new Uint8Array(1_100_000).fill(48), hang: true });
    const count = guest.process.spawned.length;
    expect(await printed('try:\n    oxidevm.run(["/bin/head", "-c", "1100000", "/dev/zero"])\nexcept Exception as error:\n    print("output limit" in str(error))')).toBe("True\n");
    expect(guest.process.spawned.slice(count).map(child => child.signals)).toEqual([[9]]);
  });

  it("turns the timeout into whole milliseconds, 10 s by default, and refuses what the host refuses", async () => {
    children.set("/bin/true", {});
    await printed('oxidevm.run(["/bin/true"])\noxidevm.run(["/bin/true"], timeout=0.07)\noxidevm.run(["/bin/true"], timeout=180)\noxidevm.run(["/bin/true"], timeout=0.0015)');
    expect(guest.nativeRequests.slice(-4).map(request => request.timeoutMs)).toEqual([10_000, 70, 180_000, 2]);
    const count = guest.process.spawned.length;
    expect(await printed(`
for timeout in (0, -1, 181, 0.0004, float("nan")):
    try:
        oxidevm.run(["/bin/true"], timeout=timeout)
        print("accepted", timeout)
    except Exception as error:
        print("refused", timeout, type(error).__name__)
`)).toBe("refused 0 JsException\nrefused -1 JsException\nrefused 181 JsException\nrefused 0.0004 JsException\nrefused nan ValueError\n");
    expect(guest.process.spawned).toHaveLength(count);
  });

  it("refuses a command line that is not a list of strings with an absolute program, before starting anything", async () => {
    const count = guest.process.spawned.length;
    expect(await printed(`
for argv in ("/bin/true", [], ["relative"], ["/bin/true", None], ["/bin/true", "a\\0b"], ["/bin/true"] * 65, [1]):
    try:
        oxidevm.run(argv)
        print("accepted", argv)
    except Exception as error:
        print("refused", type(error).__name__)
`)).toBe("refused JsException\n".repeat(7));
    expect(guest.process.spawned).toHaveLength(count);
  });

  it("refuses input that is not text", async () => {
    const count = guest.process.spawned.length;
    expect(await printed('for value in (b"bytes", 5, None):\n    try:\n        oxidevm.run(["/bin/true"], input=value)\n    except Exception as error:\n        print("refused", type(error).__name__)')).toBe("refused JsException\n".repeat(3));
    expect(guest.process.spawned).toHaveLength(count);
  });
});

describe("oxidevm.connect_unix and connect_tcp", () => {
  it("talks to a Unix socket service, and the context manager closes the connection", async () => {
    const before = guest.sockets.closed.length;
    expect(await printed(`
with oxidevm.connect_unix("${UNIX}") as connection:
    connection.sendall(b"ping")
    print(connection.recv(100))
`)).toBe("b'PING'\n");
    expect(guest.sockets.closed).toHaveLength(before + 1);
  });

  it("talks to loopback TCP by port, and to another address when given one", async () => {
    expect(await printed(`
with oxidevm.connect_tcp(5432) as one, oxidevm.connect_tcp(5432, "::1") as two:
    one.sendall(b"abc")
    two.sendall(b"def")
    print(one.recv(10), two.recv(10))
`)).toBe("b'ABC' b'DEF'\n");
    expect(guest.sockets.connected.slice(-2)).toEqual(["tcp:127.0.0.1:5432", "tcp:::1:5432"]);
  });

  it("accepts any bytes-like object", async () => {
    expect(await printed(`
with oxidevm.connect_unix("${UNIX}") as connection:
    for data in (b"a", bytearray(b"b"), memoryview(b"c")):
        connection.sendall(data)
        print(connection.recv(10), end=" ")
`)).toBe("b'A' b'B' b'C' ");
  });

  it("returns b'' when the service has closed the connection, and as many bytes as were asked for at most", async () => {
    expect(await printed(`
with oxidevm.connect_tcp(7000) as connection:
    print(connection.recv(2), connection.recv(100), connection.recv(100))
`)).toBe("b'he' b'llo' b''\n");
  });

  it("moves a megabyte in each direction", async () => {
    expect(await printed(`
with oxidevm.connect_unix("${UNIX}") as connection:
    payload = bytes(range(97, 123)) * 40_000
    connection.sendall(payload)
    received = bytearray()
    while len(received) < len(payload):
        received += connection.recv(1 << 20)
    print(len(payload), received == payload.upper())
`)).toBe("1040000 True\n");
  });

  it("raises the OSError subclass that fits, with Python's own errno", async () => {
    expect(await printed(`
def attempt(connect):
    try:
        connect()
    except OSError as error:
        return (type(error).__name__, errno.errorcode[error.errno], str(error))
print(attempt(lambda: oxidevm.connect_unix("/workspace/_oxidevm/none.sock")))
print(attempt(lambda: oxidevm.connect_tcp(6000)))
`)).toBe("('FileNotFoundError', 'ENOENT', '[Errno 44] No such file or directory')\n('ConnectionRefusedError', 'ECONNREFUSED', '[Errno 14] Connection refused')\n");
  });

  it("raises BrokenPipeError when the other side has closed the connection", async () => {
    guest.sockets.listen("tcp:127.0.0.1:7002", peer => { peer.close(); });
    const original = guest.sockets.sockets.write;
    guest.sockets.sockets.write = () => Promise.reject(new LinuxError(32));
    try {
      expect(await printed(`
with oxidevm.connect_tcp(7002) as connection:
    try:
        connection.sendall(b"hello")
    except BrokenPipeError as error:
        print("BrokenPipeError", error.errno == errno.EPIPE)
`)).toBe("BrokenPipeError True\n");
    } finally {
      guest.sockets.sockets.write = original;
    }
  });

  it("hands the bridge timeouts in whole milliseconds, at least one: a very short timeout never turns into none", async () => {
    guest.socketRequests.length = 0;
    await printed(`
with oxidevm.connect_tcp(5432, timeout=0.0001) as connection:
    connection.settimeout(0.0001)
    connection.sendall(b"a")
    connection.settimeout(2.5)
    connection.sendall(b"b")
    connection.settimeout(None)
    connection.sendall(b"c")
`);
    expect(guest.socketRequests.map(request => [request.operation, request.timeoutMs])).toEqual([["connect", 1], ["send", 1], ["send", 2500], ["send", 0]]);
  });

  it("asks for at most a megabyte in one receive, whatever size the program names", async () => {
    guest.socketRequests.length = 0;
    expect(await printed(`
with oxidevm.connect_unix("${UNIX}") as connection:
    connection.sendall(b"abc")
    print(connection.recv(50 * 1024 * 1024))
`)).toBe("b'ABC'\n");
    expect(guest.socketRequests.flatMap(request => (request.operation === "recv" ? [request.size] : []))).toEqual([1024 ** 2]);
  });

  it("times out a connection attempt and, once settimeout is used, a silent read", async () => {
    expect(await printed(`
try:
    oxidevm.connect_tcp(9, timeout=0.05)
except TimeoutError as error:
    print("connect timed out", error.errno == errno.ETIMEDOUT)
with oxidevm.connect_tcp(7001) as connection:
    print(connection.gettimeout())
    connection.settimeout(0.05)
    print(connection.gettimeout())
    try:
        connection.recv(10)
    except TimeoutError:
        print("recv timed out")
    connection.settimeout(None)
    print(connection.gettimeout())
`)).toBe("connect timed out True\nNone\n0.05\nrecv timed out\nNone\n");
  });

  it("checks what it is given, in Python's terms, before it asks the host", async () => {
    const families = guest.sockets.families.length;
    expect(await printed(`
def refuse(call):
    try:
        call()
        return "accepted"
    except Exception as error:
        return type(error).__name__
print(refuse(lambda: oxidevm.connect_unix("relative.sock")))
print(refuse(lambda: oxidevm.connect_unix(5)))
print(refuse(lambda: oxidevm.connect_unix(b"/bytes")))
print(refuse(lambda: oxidevm.connect_unix("${UNIX}", timeout=0)))
print(refuse(lambda: oxidevm.connect_tcp(0)))
print(refuse(lambda: oxidevm.connect_tcp(65536)))
print(refuse(lambda: oxidevm.connect_tcp("5432")))
print(refuse(lambda: oxidevm.connect_tcp(True)))
print(refuse(lambda: oxidevm.connect_tcp(5432, "")))
print(refuse(lambda: oxidevm.connect_tcp(5432, 5)))
print(refuse(lambda: oxidevm.connect_tcp(5432, timeout=-1)))
`)).toBe("ValueError\nTypeError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\n");
    expect(guest.sockets.families).toHaveLength(families);
  });

  it("checks sockets operations: bytes only, positive sizes, valid timeouts, and nothing after close", async () => {
    expect(await printed(`
def refuse(call):
    try:
        call()
        return "accepted"
    except Exception as error:
        return type(error).__name__ + ("/" + errno.errorcode[error.errno] if isinstance(error, OSError) else "")
connection = oxidevm.connect_unix("${UNIX}")
print(refuse(lambda: connection.sendall("text")))
print(refuse(lambda: connection.recv(0)))
print(refuse(lambda: connection.recv(-5)))
print(refuse(lambda: connection.recv("5")))
print(refuse(lambda: connection.recv(True)))
for timeout in (0, -1, "1", True):
    print(refuse(lambda: connection.settimeout(timeout)))
print(connection.gettimeout())
connection.close()
connection.close()
print(refuse(lambda: connection.sendall(b"x")))
print(refuse(lambda: connection.recv(1)))
`)).toBe("TypeError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nValueError\nNone\nOSError/EBADF\nOSError/EBADF\n");
  });

  it("holds at most 32 sockets, and the module's end closes the ones a program leaves open", async () => {
    const opened = guest.sockets.families.length;
    const closedBefore = guest.sockets.closed.length;
    expect(await printed(`
held = []
try:
    for _ in range(40):
        held.append(oxidevm.connect_unix("${UNIX}"))
except OSError as error:
    print(len(held), errno.errorcode[error.errno])
held[0].close()
held.append(oxidevm.connect_unix("${UNIX}"))
print(len(held))
`)).toBe("32 EMFILE\n33\n");
    expect(guest.sockets.families.length - opened).toBe(33);
    await guest.stop();
    // 33 were opened, one was closed by the program, the other 32 were closed when the module ended.
    expect(guest.sockets.closed.length - closedBefore).toBe(33);
  });
});
