import type { ProcessHandle } from "@oxidevm/sdk";
import { Capture, expectStatus, finishWithin, run, same, start, trace } from "./support.ts";
import type { Context } from "./support.ts";

// Scenarios about oxidevm.connect_unix and oxidevm.connect_tcp talking to services run by native Linux programs.

const UNIX_PATH = "/workspace/_oxidevm/echo.sock";
const TCP_PORT = 5599;

/** A native Python service that answers every chunk with the same bytes in upper case, one client at a time. */
function server(family: "unix" | "tcp"): string {
  const listen = family === "unix"
    ? `import os\ntry:\n    os.unlink("${UNIX_PATH}")\nexcept FileNotFoundError:\n    pass\nserver = socket.socket(socket.AF_UNIX)\nserver.bind("${UNIX_PATH}")`
    : `server = socket.socket(socket.AF_INET)\nserver.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\nserver.bind(("127.0.0.1", ${String(TCP_PORT)}))`;
  return `import socket\n${listen}\nserver.listen(8)\nprint("listening", flush=True)\nwhile True:\n    connection, _ = server.accept()\n    while True:\n        data = connection.recv(65536)\n        if not data:\n            break\n        connection.sendall(data.upper())\n    connection.close()\n`;
}

const CLIENT = `import errno, json, sys
import oxidevm

def step(name):
    print("step:", name, file=sys.stderr, flush=True)

out = {}
with oxidevm.connect_unix("${UNIX_PATH}") as connection:
    connection.settimeout(30)
    step("unix connected")
    connection.sendall(b"hello unix\\n")
    out["unix"] = connection.recv(100).decode()
    step("unix answered")
    # The service echoes each chunk before it reads the next, so a client that sent everything before it read anything could
    # fill the buffers of both sides and wait forever, as with any socket. This one reads each echo before it sends more.
    payload = b"abcdefghij" * 20000
    received = bytearray()
    for start in range(0, len(payload), 16384):
        chunk = payload[start:start + 16384]
        connection.sendall(chunk)
        while len(received) < start + len(chunk):
            received += connection.recv(65536)
    out["unix_200kb"] = bytes(received) == payload.upper()
    step("unix 200 KB echoed")
with oxidevm.connect_tcp(${String(TCP_PORT)}) as connection:
    connection.settimeout(30)
    step("tcp connected")
    connection.sendall(b"hello tcp\\n")
    out["tcp"] = connection.recv(100).decode()
    step("tcp answered")

def attempt(connect):
    try:
        connect()
        return "connected"
    except OSError as error:
        return [type(error).__name__, errno.errorcode[error.errno]]

out["missing"] = attempt(lambda: oxidevm.connect_unix("/workspace/_oxidevm/none.sock"))
out["refused"] = attempt(lambda: oxidevm.connect_tcp(5598))
step("errors checked")
with oxidevm.connect_unix("${UNIX_PATH}") as connection:
    connection.settimeout(0.3)
    try:
        connection.recv(10)
        out["silent"] = "data"
    except TimeoutError:
        out["silent"] = "TimeoutError"
print(json.dumps(out, sort_keys=True))
`;

export async function sockets(context: Context): Promise<string> {
  const { vm } = context;
  // One after the other: the engine admits one native program at a time (see the report on concurrent vm.spawn).
  const servers: ProcessHandle[] = [];
  for (const family of ["unix", "tcp"] as const) {
    trace(`starting the ${family} server`);
    const process = await vm.spawn({ command: "/usr/bin/python3", args: ["-u", "-c", server(family)], cwd: "/workspace" });
    servers.push(process);
    trace(`the ${family} server has pid ${String(process.pid)}`);
    const errors = new Capture(process.stderr);
    await new Capture(process.stdout).waitFor("listening\n").catch((error: unknown) => { throw new Error(`the ${family} server did not start: ${error instanceof Error ? error.message : String(error)}; stderr: ${errors.text}`); });
    trace(`the ${family} server is listening`);
  }
  try {
    trace("running the client");
    const result = await finishWithin(await start(context, CLIENT, { name: "sockets", packages: [] }), 120_000);
    trace(`the client ended: ${result.stdout.slice(0, 200)} ${result.stderr.slice(0, 400)}`);
    expectStatus(result, 0, "client run");
    same(JSON.parse(result.stdout), {
      missing: ["FileNotFoundError", "ENOENT"], refused: ["ConnectionRefusedError", "ECONNREFUSED"], silent: "TimeoutError",
      tcp: "HELLO TCP\n", unix: "HELLO UNIX\n", unix_200kb: true,
    }, "what the client saw");

    // A server that has gone away leaves its socket file behind; connecting to it is refused, as Linux refuses it.
    for (const process of servers) await process.kill("SIGKILL");
    await Promise.all(servers.map(process => process.exit));
    const stale = await run(context, `import errno, json, oxidevm
try:
    oxidevm.connect_unix("${UNIX_PATH}")
    print(json.dumps("connected"))
except OSError as error:
    print(json.dumps([type(error).__name__, errno.errorcode[error.errno]]))
`, { name: "sockets-stale", packages: [] });
    expectStatus(stale, 0, "stale socket run");
    same(JSON.parse(stale.stdout), ["ConnectionRefusedError", "ECONNREFUSED"], "a socket file with no server");
    return `Unix and TCP echo, 200 KB through a Unix socket, ENOENT, ECONNREFUSED (also for a stale socket file), and a read timeout; client run ${String(result.ms)} ms`;
  } finally {
    for (const process of servers) await process.kill("SIGKILL").catch(() => undefined);
  }
}
