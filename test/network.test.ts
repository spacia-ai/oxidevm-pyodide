import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NetError } from "@oxidevm/sdk/wasm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isRecord } from "../src/records.ts";
import { WHEELS } from "../src/shipped.ts";
import { fakeNet, httpServer, PRIVATE_AUTHORITY, tlsServer } from "./support/fake-net.ts";
import type { FakeNet, FakePeer } from "./support/fake-net.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture } from "./support/guest-fixture.ts";

// Python's socket, ssl and urllib through the VM's network (engine ADR 0029), with the real Pyodide in Node and a fake
// `host.net` (test/support/fake-net.ts): Pyodide's sockets go to `kit.emscripten.network`, names to the VM resolver and
// TLS to the engine's session interface. Failures are compared with what CPython 3.14 reported for the same situations
// (test/fixtures/cpython-net.json, recorded by scripts/record-cpython-net.py on loopback with openssl-made certificates).

interface Recorded { readonly type: string; readonly str: string; readonly errno: number | null; readonly reason?: string; readonly library?: string; readonly verify_code?: number; readonly verify_message?: string }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const recording: unknown = JSON.parse(readFileSync(join(root, "test/fixtures/cpython-net.json"), "utf8"));

/** What CPython reported for a case: the exception's type, text and attributes. */
function recorded(name: string): Recorded {
  const cases = isRecord(recording) ? recording["cases"] : undefined;
  const entry = isRecord(cases) ? cases[name] : undefined;
  const error = isRecord(entry) ? entry["error"] : undefined;
  if (!isRecord(error) || typeof error["type"] !== "string" || typeof error["str"] !== "string") throw new Error(`cpython-net.json has no error for ${name}`);
  const optional = <T>(key: string, check: (value: unknown) => value is T): Partial<Record<string, T>> => (check(error[key]) ? { [key]: error[key] } : {});
  const isString = (value: unknown): value is string => typeof value === "string", isNumber = (value: unknown): value is number => typeof value === "number";
  return { type: error["type"], str: error["str"], errno: typeof error["errno"] === "number" ? error["errno"] : null, ...optional("reason", isString), ...optional("library", isString), ...optional("verify_code", isNumber), ...optional("verify_message", isString) };
}

/** Python that runs `action` and prints, as JSON, what the exception it raised looks like (the fields `recorded` has). */
function describing(action: string): string {
  return `import json, ssl, socket, urllib.request
def describe(error):
    seen = {"type": type(error).__module__ + "." + type(error).__qualname__, "str": str(error), "errno": getattr(error, "errno", None)}
    for name in ("reason", "library", "verify_code", "verify_message"):
        value = getattr(error, name, None)
        if isinstance(value, (str, int)):
            seen[name] = value
    return seen
try:
    ${action}
    print(json.dumps({"result": "no error"}))
except Exception as error:
    print(json.dumps(describe(error)))
`;
}

/** A certificate CPython decoded: its DER, and the repr of the dict its getpeercert() returned for it. */
function recordedCertificate(name: string): { readonly der: Uint8Array; readonly decoded: string } {
  const certificates = isRecord(recording) ? recording["certificates"] : undefined;
  const entry = isRecord(certificates) ? certificates[name] : undefined;
  if (!isRecord(entry) || typeof entry["der"] !== "string" || typeof entry["decoded"] !== "string") throw new Error(`cpython-net.json has no certificate ${name}`);
  return { der: Uint8Array.from(Buffer.from(entry["der"], "base64")), decoded: entry["decoded"] };
}

/** What CPython's version() and cipher() returned for a connection (`peer` in the recording). */
function recordedPeer(name: string): { readonly version: string; readonly cipher: readonly unknown[] } {
  const peers = isRecord(recording) ? recording["peer"] : undefined;
  const entry = isRecord(peers) ? peers[name] : undefined;
  if (!isRecord(entry) || typeof entry["version"] !== "string" || !Array.isArray(entry["cipher"])) throw new Error(`cpython-net.json has no peer ${name}`);
  return { version: entry["version"], cipher: Array.from<unknown>(entry["cipher"]) };
}

const RICH = recordedCertificate("rich"), AUTHORITY = recordedCertificate("rich-ca");
const RICH_PEER: FakePeer = { certificates: [RICH.der, AUTHORITY.der], version: "TLSv1.3", suite: 0x1302 };

async function failureOf(action: string): Promise<unknown> {
  const result = await guest.run(describing(action));
  expect(result.status, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

let guest: GuestFixture;
let net: FakeNet;

beforeAll(async () => {
  net = fakeNet({ "example.test": ["93.184.216.34"], "untrusted.test": ["93.184.216.35"], "wrong-name.test": ["93.184.216.35"], "expired.test": ["93.184.216.35"], "self-signed.test": ["93.184.216.35"], "both.test": ["2001:db8::7", "93.184.216.34"], "quiet.test": ["93.184.216.36"], "private.test": ["93.184.216.37"], localhost: ["127.0.0.1"] }, {
    "93.184.216.34:80": httpServer("plain hello"),
    "93.184.216.34:443": tlsServer(httpServer("secure hello")),
    "93.184.216.35:443": tlsServer(httpServer("never served")),
    "127.0.0.1:8000": httpServer("from the VM"),
    "93.184.216.34:7": () => () => ({}),
    "93.184.216.36:443": tlsServer(() => () => ({})),
    "93.184.216.37:443": tlsServer(httpServer("private hello")),
  }, RICH_PEER);
  guest = await startGuest(undefined, { net: net.host });
  // The HTTP libraries, unpacked as the module's import hook unpacks them (src/python-loader.ts loads them in the browser).
  const sitePackages: unknown = guest.py.runPython("import sysconfig\nsysconfig.get_path('purelib')");
  if (typeof sitePackages !== "string") throw new Error("Pyodide did not report its site-packages directory");
  for (const wheel of [WHEELS.requests, WHEELS.urllib3, WHEELS.idna, WHEELS["charset-normalizer"], WHEELS.certifi, WHEELS.httpx, WHEELS.httpcore, WHEELS.h11]) {
    guest.py.unpackArchive(Uint8Array.from(readFileSync(join(root, "upstream", wheel))), "wheel", { extractDir: sitePackages });
  }
  guest.py.runPython("import importlib\nimportlib.invalidate_caches()");
}, 120_000);

afterEach(() => { net.connected = true; net.onBlockedRead = undefined; net.peer = RICH_PEER; net.readTimeouts.length = 0; net.trusted.length = 0; });

afterAll(async () => {
  await guest.stop();
  await guest.dispose();
});

describe("names, through the VM's resolver", () => {
  it("resolves names for getaddrinfo, gethostbyname and gethostbyname_ex (IPv4, as Pyodide's sockets take), and leaves numeric addresses alone", async () => {
    const result = await guest.run("import socket\nprint(socket.getaddrinfo('example.test', 80, type=socket.SOCK_STREAM)[0][4])\nprint(socket.gethostbyname('example.test'), socket.gethostbyname_ex('example.test'))\nprint(socket.getaddrinfo('10.0.0.1', 80, type=socket.SOCK_STREAM)[0][4])\nprint([entry[4][0] for entry in socket.getaddrinfo('both.test', 80, type=socket.SOCK_STREAM)])\nprint([entry[4][0] for entry in socket.getaddrinfo('both.test', 80, socket.AF_INET, socket.SOCK_STREAM)])\nprint(socket.getaddrinfo('example.test', 80, type=socket.SOCK_STREAM, flags=socket.AI_CANONNAME)[0][3])\n");
    expect(result).toEqual({ status: 0, stdout: "('93.184.216.34', 80)\n93.184.216.34 ('example.test', [], ['93.184.216.34'])\n('10.0.0.1', 80)\n['93.184.216.34']\n['93.184.216.34']\nexample.test\n", stderr: "" });
  });

  it("fails for a name that does not exist as CPython does: socket.gaierror -2 with glibc's text", async () => {
    for (const [call, name] of [["socket.getaddrinfo('nonexistent.invalid', 80)", "getaddrinfo-unresolvable"], ["socket.gethostbyname('nonexistent.invalid')", "gethostbyname-unresolvable"], ["socket.create_connection(('nonexistent.invalid', 80), timeout=10)", "create-connection-unresolvable"]] as const) {
      expect(await failureOf(call), call).toEqual(recorded(name));
    }
    expect(await failureOf("urllib.request.urlopen('http://nonexistent.invalid/', timeout=10)")).toEqual(recorded("urlopen-unresolvable"));
  });

  it("reports a nameserver that does not answer as a temporary failure (gaierror -3)", async () => {
    expect(await failureOf("socket.getaddrinfo('slow.test', 80)")).toEqual({ type: "socket.gaierror", str: "[Errno -3] Temporary failure in name resolution", errno: -3 });
  });
});

describe("connections, through the VM's sockets", () => {
  it("talks HTTP with urllib and with a plain socket, to the internet and to the VM", async () => {
    const result = await guest.run("import socket, urllib.request\nwith urllib.request.urlopen('http://example.test/path?q=1') as response:\n    print(response.status, response.headers['X-Request-Line'], response.read())\nwith socket.create_connection(('localhost', 8000)) as connection:\n    connection.sendall(b'GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n')\n    print(connection.recv(4096).split(b'\\r\\n\\r\\n')[1])\n");
    expect(result).toEqual({ status: 0, stdout: "200 GET /path?q=1 HTTP/1.1 b'plain hello'\nb'from the VM'\n", stderr: "" });
  });

  it("raises ConnectionRefusedError, with CPython's text, for a port nobody listens on", async () => {
    const seen = await guest.run("import errno, socket\ntry:\n    socket.create_connection(('127.0.0.1', 9), timeout=10)\nexcept ConnectionRefusedError as error:\n    print(error.errno == errno.ECONNREFUSED, error.strerror)\n");
    expect(seen).toEqual({ status: 0, stdout: `True ${recorded("create-connection-refused").str.replace(/^\[Errno \d+\] /u, "")}\n`, stderr: "" });
  });

  it("fails with EPERM while the VM is not connected to the internet, as URLError(PermissionError) from urllib", async () => {
    net.connected = false;
    const result = await guest.run("import errno, socket, urllib.request, urllib.error\nfor url in ('https://example.test/', 'http://93.184.216.34/'):\n    try:\n        urllib.request.urlopen(url, timeout=10)\n    except urllib.error.URLError as error:\n        print(type(error.reason).__name__, error.reason.errno == errno.EPERM)\nprint(urllib.request.urlopen('http://localhost:8000/').read())\n");
    expect(result).toEqual({ status: 0, stdout: "PermissionError True\nPermissionError True\nb'from the VM'\n", stderr: "" });
  });

  it("raises KeyboardInterrupt when Ctrl+C ends a read that waits for the server", async () => {
    net.onBlockedRead = () => { guest.interrupts[0] = 2; throw new NetError("EIO", "read interrupted", { errno: 4 }); };
    const result = await guest.run("import socket\nconnection = socket.create_connection(('example.test', 7))\nconnection.recv(10)\nprint('not reached')\n");
    expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
    expect(result.stderr).toMatch(/line 3, in <module>[\s\S]*KeyboardInterrupt\n$/u);
  });
});

describe("TLS, through the engine's client", () => {
  it("fetches over HTTPS with urllib and http.client, with ALPN, and frees every session", async () => {
    const result = await guest.run("import http.client, ssl, urllib.request\nprint(urllib.request.urlopen('https://example.test/secure').read())\ncontext = ssl.create_default_context()\ncontext.set_alpn_protocols(['http/1.1'])\nconnection = http.client.HTTPSConnection('example.test', context=context)\nconnection.request('GET', '/again')\nprint(connection.sock.selected_alpn_protocol(), connection.sock.getpeercert()['subject'][5], len(connection.sock.getpeercert(True)))\nresponse = connection.getresponse()\nprint(response.status, response.read())\nconnection.close()\n");
    expect(result).toEqual({ status: 0, stdout: `b'secure hello'\nhttp/1.1 (('commonName', 'rich.example'),) ${String(RICH.der.length)}\n200 b'secure hello'\n`, stderr: "" });
    expect(net.open.size).toBe(0);
  });

  it("refuses a certificate the VM does not trust with CPython's SSLCertVerificationError", async () => {
    expect(await failureOf("socket_ = socket.create_connection(('untrusted.test', 443)); ssl.create_default_context().wrap_socket(socket_, server_hostname='untrusted.test')")).toEqual(recorded("tls-good-default"));
    const other = recorded("tls-other-trusting");
    expect(await failureOf("socket_ = socket.create_connection(('wrong-name.test', 443)); ssl.create_default_context().wrap_socket(socket_, server_hostname='wrong-name.test')"))
      .toEqual({ ...other, str: other.str.replace("'localhost'", "'wrong-name.test'"), ...(other.verify_message === undefined ? {} : { verify_message: other.verify_message.replace("'localhost'", "'wrong-name.test'") }) });
    expect(await failureOf("socket_ = socket.create_connection(('expired.test', 443)); ssl.create_default_context().wrap_socket(socket_, server_hostname='expired.test')")).toEqual(recorded("tls-expired-trusting"));
    const url = recorded("urlopen-tls-expired-trusting");
    expect(await failureOf("urllib.request.urlopen('https://expired.test/', timeout=10)")).toEqual({ type: url.type, str: url.str, errno: url.errno });
    expect(net.open.size).toBe(0);
  });

  it("refuses a certificate the engine finds unusable (a self-signed one) as a verification failure without OpenSSL's finer reason", async () => {
    expect(await failureOf("socket_ = socket.create_connection(('self-signed.test', 443)); ssl.create_default_context().wrap_socket(socket_, server_hostname='self-signed.test')")).toEqual({
      type: "ssl.SSLCertVerificationError", str: "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unspecified certificate verification error (_ssl.c:1081)",
      errno: 1, reason: "CERTIFICATE_VERIFY_FAILED", library: "SSL", verify_code: 1, verify_message: "unspecified certificate verification error",
    });
  });

  it("verifies even when the program asks it not to, and says so in a note on the error", async () => {
    const result = await guest.run("import socket, ssl\ncontext = ssl._create_unverified_context()\ntry:\n    context.wrap_socket(socket.create_connection(('untrusted.test', 443)), server_hostname='untrusted.test')\nexcept ssl.SSLCertVerificationError as error:\n    print(error.verify_code, error.__notes__)\nprint(context.wrap_socket(socket.create_connection(('example.test', 443)), server_hostname='example.test').getpeercert())\n");
    expect(result).toEqual({ status: 0, stdout: "20 [\"This VM's TLS always verifies certificates, against /etc/ssl/cert.pem and the authorities the program loads (load_verify_locations); it cannot be turned off.\"]\n{}\n", stderr: "" });
  });

  it("refuses server-side TLS and client certificates with ssl.SSLError, and needs the server's name", async () => {
    const result = await guest.run("import socket, ssl\nserver = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)\ntry:\n    server.wrap_socket(socket.create_connection(('example.test', 443)), server_side=True)\nexcept ssl.SSLError as error:\n    print(error)\ncontext = ssl.create_default_context()\ncontext.check_hostname = False\ntry:\n    context.wrap_socket(socket.create_connection(('example.test', 443)))\nexcept ValueError as error:\n    print(error)\n");
    expect(result).toEqual({ status: 0, stdout: "[SSL] server-side TLS is not available in this VM (_ssl.c:1081)\nthis VM's TLS needs server_hostname to verify the server\n", stderr: "" });
  });

  it("runs a session over memory BIOs: SSLWantReadError until the peer answers, then plaintext both ways", async () => {
    const result = await guest.run("import ssl\nincoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()\nobj = ssl.create_default_context().wrap_bio(incoming, outgoing, server_hostname='example.test')\ntry:\n    obj.do_handshake()\nexcept ssl.SSLWantReadError:\n    print('want read', outgoing.read())\nincoming.write(b'WELCOME\\n')\nobj.do_handshake()\nprint(obj.write(b'ping'), outgoing.read())\ntry:\n    obj.read(10)\nexcept ssl.SSLWantReadError:\n    print('want read again')\nincoming.write(b'pong')\nprint(obj.pending(), obj.read(10), obj.pending(), obj.server_hostname)\n");
    expect(result).toEqual({ status: 0, stdout: "want read b'HELLO example.test\\n'\n4 b'ping'\nwant read again\n0 b'pong' 0 example.test\n", stderr: "" });
  });

  it("reads a whole response through makefile and treats a close without close_notify as the end", async () => {
    const result = await guest.run("import socket, ssl\nwith ssl.create_default_context().wrap_socket(socket.create_connection(('example.test', 443)), server_hostname='example.test') as secured:\n    secured.sendall(b'GET / HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n')\n    data = secured.makefile('rb').read()\n    print(data.split(b'\\r\\n\\r\\n')[1], secured.recv(10))\n");
    expect(result).toEqual({ status: 0, stdout: "b'secure hello' b''\n", stderr: "" });
  });
});

describe("what the server presented (engine TLS API 2)", () => {
  const connect = "secured = ssl.create_default_context().wrap_socket(socket.create_connection(('example.test', 443)), server_hostname='example.test')\n";

  it("shows the server's certificate exactly as CPython 3.14 decodes it, and its DER with binary_form", async () => {
    for (const [certificate, peer] of [[RICH, RICH_PEER], [AUTHORITY, { ...RICH_PEER, certificates: [AUTHORITY.der] }]] as const) {
      net.peer = peer;
      const result = await guest.run(`import socket, ssl\n${connect}print(repr(secured.getpeercert()))\nprint(secured.getpeercert(binary_form=True).hex())\n`);
      expect(result).toEqual({ status: 0, stdout: `${certificate.decoded}\n${Buffer.from(certificate.der).toString("hex")}\n`, stderr: "" });
    }
  });

  it("reports the protocol version and the cipher as CPython does, over TLS 1.3 and TLS 1.2", async () => {
    for (const [name, version, suite] of [["tls13", "TLSv1.3", 0x1302], ["tls12-aes128", "TLSv1.2", 0xc02b], ["tls12-aes256", "TLSv1.2", 0xc02c], ["tls12-chacha20", "TLSv1.2", 0xcca9]] as const) {
      net.peer = { ...RICH_PEER, version, suite };
      const recordedOne = recordedPeer(name);
      const result = await guest.run(`import json, socket, ssl\n${connect}print(json.dumps([secured.version(), list(secured.cipher())]))\n`);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual([recordedOne.version, recordedOne.cipher]);
    }
  });

  it("is empty for a context that does not ask for verification, as in CPython, and None without a certificate", async () => {
    const unverified = await guest.run("import socket, ssl\ncontext = ssl._create_unverified_context()\nsecured = context.wrap_socket(socket.create_connection(('example.test', 443)), server_hostname='example.test')\nprint(secured.getpeercert(), len(secured.getpeercert(True)))\n");
    expect(unverified).toEqual({ status: 0, stdout: `{} ${String(RICH.der.length)}\n`, stderr: "" });
    net.peer = { ...RICH_PEER, certificates: [] };
    expect(await guest.run(`import socket, ssl\n${connect}print(secured.getpeercert(), secured.getpeercert(True))\n`)).toEqual({ status: 0, stdout: "None None\n", stderr: "" });
  });

  it("raises ValueError for the certificate, and has no version or cipher, before the handshake (memory BIOs too)", async () => {
    const result = await guest.run("import ssl\nobj = ssl.create_default_context().wrap_bio(ssl.MemoryBIO(), ssl.MemoryBIO(), server_hostname='example.test')\ntry:\n    obj.getpeercert()\nexcept ValueError as error:\n    print(error)\nprint(obj.version(), obj.cipher())\nobj._incoming.write(b'WELCOME\\n')\nobj.do_handshake()\nprint(obj.version(), obj.cipher(), obj.getpeercert()['notAfter'])\n");
    expect(result).toEqual({ status: 0, stdout: "handshake not done yet\nNone None\nTLSv1.3 ('TLS_AES_256_GCM_SHA384', 'TLSv1.3', 256) Jun 15 12:00:00 2051 GMT\n", stderr: "" });
  });
});

describe("authorities a program adds (load_verify_locations, engine TLS API 2 trust)", () => {
  const PEM = `-----BEGIN CERTIFICATE-----\\n${PRIVATE_AUTHORITY}\\n-----END CERTIFICATE-----\\n`;

  it("trusts a CA file, a directory of them, or cadata, for that context only, and so do urllib, requests and httpx", async () => {
    const result = await guest.run(`import os, socket, ssl, urllib.request, requests, httpx
open('/workspace/ca.pem', 'w').write(${JSON.stringify(PEM)})
os.makedirs('/workspace/certs', exist_ok=True)
open('/workspace/certs/ca.pem', 'w').write(${JSON.stringify(PEM)})
open('/workspace/certs/readme.txt', 'w').write('not a certificate')
for context in (ssl.create_default_context(cafile='/workspace/ca.pem'), ssl.create_default_context(capath='/workspace/certs'), ssl.create_default_context(cadata=${JSON.stringify(PEM)}), ssl.create_default_context(cadata=b'0' + ${JSON.stringify(PRIVATE_AUTHORITY)}.encode())):
    secured = context.wrap_socket(socket.create_connection(('private.test', 443)), server_hostname='private.test')
    print(secured.version(), end=' ')
    secured.close()
print()
try:
    ssl.create_default_context().wrap_socket(socket.create_connection(('private.test', 443)), server_hostname='private.test')
except ssl.SSLCertVerificationError as error:
    print('default context', error.verify_code)
print(urllib.request.urlopen('https://private.test/', context=ssl.create_default_context(cafile='/workspace/ca.pem')).read())
print(requests.get('https://private.test/', verify='/workspace/ca.pem', timeout=10).text)
print(httpx.get('https://private.test/', verify=ssl.create_default_context(cafile='/workspace/ca.pem')).text)
`);
    expect(result).toEqual({ status: 0, stdout: "TLSv1.3 TLSv1.3 TLSv1.3 TLSv1.3 \ndefault context 20\nb'private hello'\nprivate hello\nprivate hello\n", stderr: "" });
    // A directory adds only its certificate files; a context without authorities adds none.
    expect(net.trusted.slice(0, 5)).toEqual([1, 1, 1, 1, 0]);
  });

  it("fails as CPython 3.14 does for a file or data without a certificate, and for nothing at all", async () => {
    await guest.run("open('/workspace/empty.pem', 'w').close()\n");
    for (const [call, name] of [["ssl.create_default_context().load_verify_locations(cafile='/workspace/empty.pem')", "cafile-empty"], ["ssl.create_default_context().load_verify_locations(cadata='hello')", "cadata-text-without-certificate"],
      ["ssl.create_default_context().load_verify_locations(cadata=b'hello')", "cadata-bytes-without-certificate"], ["ssl.create_default_context().load_verify_locations()", "load-verify-locations-nothing"],
      ["ssl.create_default_context().load_verify_locations(cadata=5)", "cadata-wrong-type"]] as const) {
      expect(await failureOf(call), call).toEqual(recorded(name));
    }
    // Pyodide numbers ENOENT as Emscripten does (44), so the number differs from Linux's 2; the type and the text do not.
    const missing = recorded("cafile-missing");
    expect(await failureOf("ssl.create_default_context().load_verify_locations(cafile='/workspace/missing.pem')")).toEqual({ ...missing, str: missing.str.replace("[Errno 2]", "[Errno 44]"), errno: 44 });
  });

  it("reports an authority the engine cannot use as ssl.SSLError when the session opens", async () => {
    const result = await guest.run("import socket, ssl\ncontext = ssl.create_default_context(cadata='-----BEGIN CERTIFICATE-----\\nNOT A CA\\n-----END CERTIFICATE-----\\n')\ntry:\n    context.wrap_socket(socket.create_connection(('private.test', 443)), server_hostname='private.test')\nexcept ssl.SSLError as error:\n    print(type(error).__name__, error)\n");
    expect(result).toEqual({ status: 0, stdout: "SSLError [SSL: ERR_TLS_INVALID_TRUST] TLS: a trust entry holds no usable CA certificate (_ssl.c:1081)\n", stderr: "" });
  });
});

describe("socket timeouts, as receive timeouts of the VM's connections", () => {
  it("raises TimeoutError('timed out') as CPython does when a recv waits longer than settimeout", async () => {
    expect(await failureOf("connection = socket.create_connection(('example.test', 7), timeout=10); connection.settimeout(0.2); connection.recv(10)")).toEqual(recorded("recv-timeout"));
    expect(await failureOf("socket.create_connection(('example.test', 7), timeout=0.2).recv(10)")).toEqual(recorded("create-connection-recv-timeout"));
    expect(net.readTimeouts).toEqual([200, 200]);
  });

  it("raises BlockingIOError (EAGAIN) on a non-blocking socket, and blocks again with settimeout(None)", async () => {
    const recordedOne = recorded("recv-nonblocking");
    const result = await guest.run("import errno, socket\nconnection = socket.create_connection(('example.test', 7))\nconnection.setblocking(False)\ntry:\n    connection.recv(10)\nexcept BlockingIOError as error:\n    print(error.errno == errno.EAGAIN, error.strerror)\nconnection.settimeout(None)\ntry:\n    connection.recv(10)\nexcept OSError as error:\n    print(type(error).__name__, error.errno == errno.ETIMEDOUT)\n");
    expect(result).toEqual({ status: 0, stdout: `True ${recordedOne.str.replace(/^\[Errno \d+\] /u, "")}\nTimeoutError True\n`, stderr: "" });
    // The second read had no timeout: the fake's own blocked read failed it, not a receive timeout.
    expect(net.readTimeouts).toEqual([1]);
  });

  it("takes socket.setdefaulttimeout, rounds up to whole milliseconds, and bounds TLS reads too", async () => {
    const result = await guest.run("import socket, ssl\nsocket.setdefaulttimeout(0.3005)\ntry:\n    socket.create_connection(('example.test', 7)).recv(10)\nexcept TimeoutError as error:\n    print('plain', error)\nfinally:\n    socket.setdefaulttimeout(None)\nsecured = ssl.create_default_context().wrap_socket(socket.create_connection(('quiet.test', 443)), server_hostname='quiet.test')\nsecured.settimeout(0.25)\ntry:\n    secured.recv(10)\nexcept TimeoutError as error:\n    print('tls', error)\n");
    expect(result).toEqual({ status: 0, stdout: "plain timed out\ntls timed out\n", stderr: "" });
    expect(net.readTimeouts).toEqual([301, 250]);
  });
});

describe("names below Python's socket module", () => {
  it("resolves a name given to socket.connect through the VM, failing as CPython does", async () => {
    expect(await failureOf("socket.socket().connect(('nonexistent.invalid', 80))")).toEqual(recorded("socket-connect-unresolvable"));
    const result = await guest.run("import socket\nconnection = socket.socket()\nprint(connection.connect_ex(('localhost', 8000)))\nconnection.sendall(b'GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n')\nprint(connection.recv(4096).split(b'\\r\\n\\r\\n')[1])\n");
    expect(result).toEqual({ status: 0, stdout: "0\nb'from the VM'\n", stderr: "" });
  });

  it("makes the C library's getaddrinfo fail for a name the VM cannot resolve (kit.emscripten.networkImports)", async () => {
    const result = await guest.run("import _socket\nfor name in ('nonexistent.invalid', 'slow.test'):\n    try:\n        print(_socket.getaddrinfo(name, 80))\n    except _socket.gaierror as error:\n        print(error.errno)\nprint(_socket.getaddrinfo('example.test', 80, 0, _socket.SOCK_STREAM)[0][4])\n");
    expect(result).toEqual({ status: 0, stdout: "-2\n-3\n('93.184.216.34', 80)\n", stderr: "" });
  });
});

describe("requests and httpx, on the VM's sockets instead of the browser's fetch", () => {
  it("gets a page over HTTPS with requests, through urllib3's own connections", async () => {
    const before = net.connections.length;
    const result = await guest.run("import requests\nresponse = requests.get('https://example.test/r', timeout=10)\nprint(response.status_code, response.text, response.headers['X-Request-Line'])\nimport urllib3.connection\nprint(urllib3.connection.HTTPSConnection.__module__)\n");
    expect(result).toEqual({ status: 0, stdout: "200 secure hello GET /r HTTP/1.1\nurllib3.connection\n", stderr: "" });
    expect(net.connections.slice(before)).toEqual(["93.184.216.34:443"]);
  });

  it("raises requests' own errors for a certificate the VM does not trust and while the VM is offline", async () => {
    const untrusted = await guest.run("import requests\ntry:\n    requests.get('https://untrusted.test/', timeout=10)\nexcept requests.exceptions.SSLError as error:\n    print('SSLError', 'CERTIFICATE_VERIFY_FAILED' in str(error))\n");
    expect(untrusted).toEqual({ status: 0, stdout: "SSLError True\n", stderr: "" });
    net.connected = false;
    const offline = await guest.run("import requests\ntry:\n    requests.get('https://example.test/', timeout=10)\nexcept requests.exceptions.ConnectionError as error:\n    print('ConnectionError', 'Operation not permitted' in str(error))\n");
    expect(offline).toEqual({ status: 0, stdout: "ConnectionError True\n", stderr: "" });
  });

  it("gets a page with httpx through its httpcore transport", async () => {
    const before = net.connections.length;
    const result = await guest.run("import httpx\nresponse = httpx.get('https://example.test/x', timeout=10)\nprint(response.status_code, response.text)\nprint(type(httpx.Client()._transport).__name__)\n");
    expect(result).toEqual({ status: 0, stdout: "200 secure hello\nHTTPCoreTransport\n", stderr: "" });
    expect(net.connections.slice(before)).toEqual(["93.184.216.34:443"]);
  });
});
