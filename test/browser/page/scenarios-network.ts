import { check, decoder, encoder, sleep } from "./support.ts";
import type { Context } from "./support.ts";
import { Capture } from "./support.ts";

// Python's network through the real engine (engine ADR 0029), with the VM local-only: servers run as native Linux programs
// in the VM (the image's /usr/bin/python3), the module's python3 reaches them through its own VM sockets, and the
// internet is refused. HTTPS to the internet needs a relay; that run is recorded separately (README.md, Network).

const WORK = "/workspace/_oxidevm";

/** A self-signed certificate for localhost that the VM does not trust (made for this test with openssl; not a secret). */
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUGRKHA/Ahrn6kF1YnU4ML1LDoZ5owCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwMjIyNDg1NFoYDzIxMjYxMDA5
MjI0ODU0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARroMwUj//LhTLOoLm3pLnbfdQm7/OaCIjB6j7mS8ZGJm/9AeZB3lxf
3KriwfCUFJ14vEcCwkff17PDvsLNpXNDo2kwZzAdBgNVHQ4EFgQUaWGskorHwAv4
HBhB+cBpppDsq58wHwYDVR0jBBgwFoAUaWGskorHwAv4HBhB+cBpppDsq58wDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
SAAwRQIgSb0JR6gpRX539s/ulFsh/FaYQZhGSZkfOQkcylxEoZwCIQCztop8Wv/E
WBUVx0uyUvQDH2wz+z5GbyDtp76U3H6aCw==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgPYWtHC0R/zjWrkYo
li4Z19S89nGb1yxvAQeYz/GKOhWhRANCAARroMwUj//LhTLOoLm3pLnbfdQm7/Oa
CIjB6j7mS8ZGJm/9AeZB3lxf3KriwfCUFJ14vEcCwkff17PDvsLNpXND
-----END PRIVATE KEY-----
`;

interface Shell { readonly code: number; readonly stdout: string; readonly stderr: string }

async function shell(context: Context, line: string): Promise<Shell> {
  const result = await context.vm.exec({ command: "/bin/sh", args: ["-c", line], cwd: WORK });
  return { code: result.exit.kind === "exited" ? result.exit.code : 128 + result.exit.signalNumber, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

/** Starts a native Python server in the VM and waits until it prints its ready line. */
async function nativeServer(context: Context, script: string, ready: string): Promise<{ stop(): Promise<void> }> {
  await context.vm.workspace.writeText(`_oxidevm/${ready}.py`, script);
  const handle = await context.vm.spawn({ command: "/usr/bin/python3", args: [`${WORK}/${ready}.py`], cwd: WORK });
  const output = new Capture(handle.stdout);
  await output.waitFor(ready, 60_000);
  return { stop: async () => { await handle.kill("SIGKILL").catch(() => undefined); await handle.exit.catch(() => undefined); } };
}

export async function networkOffline(context: Context): Promise<string> {
  const result = await shell(context, `python3 -c "import errno, urllib.request, urllib.error
for url in ('https://example.com/', 'http://93.184.216.34/'):
    try:
        urllib.request.urlopen(url, timeout=20)
    except urllib.error.URLError as error:
        print(type(error.reason).__name__, error.reason.errno == errno.EPERM)"`);
  check(result.code === 0 && result.stdout === "PermissionError True\nPermissionError True\n", `urllib while the VM is local-only: ${JSON.stringify(result)}`);
  return "with the VM local-only, urllib fails with URLError(PermissionError EPERM) for a name and for an address, and python3 exits 0 as the program chose";
}

export async function networkVmHttp(context: Context): Promise<string> {
  const server = await nativeServer(context, "import http.server, sys\nclass H(http.server.BaseHTTPRequestHandler):\n    def do_GET(self):\n        body = ('vm says ' + self.path).encode()\n        self.send_response(200)\n        self.send_header('Content-Length', str(len(body)))\n        self.end_headers()\n        self.wfile.write(body)\n    def log_message(self, *args):\n        pass\nserver = http.server.HTTPServer(('127.0.0.1', 8765), H)\nprint('http-ready', flush=True)\nserver.serve_forever()\n", "http-ready");
  try {
    const urllib = await shell(context, "python3 -c \"import urllib.request; print(urllib.request.urlopen('http://localhost:8765/one').read().decode())\"");
    check(urllib.code === 0 && urllib.stdout === "vm says /one\n", `urllib to a server in the VM: ${JSON.stringify(urllib)}`);
    const requests = await shell(context, "python3 -c \"import requests; response = requests.get('http://127.0.0.1:8765/two', timeout=20); print(response.status_code, response.text)\"");
    check(requests.code === 0 && requests.stdout === "200 vm says /two\n", `requests to a server in the VM: ${JSON.stringify(requests)}`);
  } finally {
    await server.stop();
  }
  return "urllib and requests (loaded on import) reach a native HTTP server in the VM through the module's own sockets, by name (localhost) and by address";
}

export async function networkVmTls(context: Context): Promise<string> {
  await context.vm.workspace.writeText("_oxidevm/tls-cert.pem", CERTIFICATE);
  await context.vm.workspace.writeText("_oxidevm/tls-key.pem", KEY);
  const server = await nativeServer(context, `import socket, ssl\ncontext = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)\ncontext.load_cert_chain('${WORK}/tls-cert.pem', '${WORK}/tls-key.pem')\nlistener = socket.create_server(('127.0.0.1', 8443))\nprint('tls-ready', flush=True)\nwhile True:\n    connection, _ = listener.accept()\n    try:\n        with context.wrap_socket(connection, server_side=True) as secured:\n            secured.recv(100)\n    except (ssl.SSLError, OSError):\n        pass\n`, "tls-ready");
  try {
    const result = await shell(context, "python3 -c \"import socket, ssl\ntry:\n    ssl.create_default_context().wrap_socket(socket.create_connection(('localhost', 8443)), server_hostname='localhost')\nexcept ssl.SSLCertVerificationError as error:\n    print(error.reason, str(error).startswith('[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: '))\"");
    check(result.code === 0 && result.stdout === "CERTIFICATE_VERIFY_FAILED True\n", `TLS to a server whose certificate the VM does not trust: ${JSON.stringify(result)}`);
  } finally {
    await server.stop();
  }
  return "the engine's TLS client refused a self-signed certificate that /etc/ssl/cert.pem does not vouch for, with CPython's SSLCertVerificationError";
}

export async function networkInterruptRecv(context: Context): Promise<string> {
  const server = await nativeServer(context, "import socket, time\nlistener = socket.create_server(('127.0.0.1', 8766))\nprint('silent-ready', flush=True)\nkept = []\nwhile True:\n    kept.append(listener.accept()[0])\n", "silent-ready");
  try {
    await context.vm.workspace.writeText("_oxidevm/waits.py", "import socket\nconnection = socket.create_connection(('127.0.0.1', 8766))\nprint('connected', flush=True)\nconnection.recv(10)\n");
    const handle = await context.vm.spawn({ command: "/bin/sh", args: ["-i"], cwd: WORK, terminal: { columns: 100, rows: 30 } });
    const writer = handle.stdin.getWriter(), output = new Capture(handle.output);
    await writer.write(encoder.encode(`NO_COLOR=1 python3 ${WORK}/waits.py\n`));
    await output.waitFor("connected", 60_000);
    await sleep(500);
    await handle.interrupt();
    await output.waitFor("KeyboardInterrupt", 30_000);
    await writer.write(encoder.encode('echo "s$((1+1))=$?"\n'));
    await output.waitFor("s2=");
    await sleep(300);
    const shown = output.text;
    await writer.write(encoder.encode("exit\n"));
    await handle.exit;
    check(shown.includes("s2=130") && shown.includes("connection.recv(10)"), `Ctrl+C during recv: ${JSON.stringify(shown.slice(-800))}`);
  } finally {
    await server.stop();
  }
  return "Ctrl+C during a recv that waits for a silent server in the VM raised KeyboardInterrupt and ended python3 by SIGINT (130)";
}

export const NETWORK_SCENARIOS: readonly (readonly [name: string, run: (context: Context) => Promise<string>])[] = [
  ["network: while the VM is local-only, urllib fails with EPERM", networkOffline],
  ["network: urllib and requests reach a server in the VM", networkVmHttp],
  ["network: TLS refuses a certificate the VM does not trust", networkVmTls],
  ["network: Ctrl+C ends a recv that waits", networkInterruptRecv],
];
