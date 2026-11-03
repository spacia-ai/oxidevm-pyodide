import { check, encoder, sleep } from "./support.ts";
import type { Context } from "./support.ts";
import { Capture } from "./support.ts";

// Python on the "internet" through the real engine (engine ADR 0029): the VM connects to the relay test peer
// (test/browser/relay/peer.ts), whose DNS names tls.test and its siblings and routes them to HTTPS servers on the test
// machine, so the bytes leave the VM through the relay as they would to a real server. The servers' certificates come
// from a throwaway root that the program trusts with cafile= (engine TLS API 2, trust); nothing turns verification off.

const WORK = "/workspace/_oxidevm";
const CA = `${WORK}/internet-ca.pem`;

/** What the harness gives the page for these scenarios (`--internet`). */
export interface InternetConfig {
  readonly relayUrl: string;
  /** The throwaway root that issued the servers' certificates, PEM. */
  readonly root: string;
}

interface Shell { readonly code: number; readonly stdout: string; readonly stderr: string }

async function python(context: Context, program: string): Promise<Shell> {
  await context.vm.workspace.writeText("_oxidevm/internet.py", program);
  const result = await context.vm.exec({ command: "/bin/sh", args: ["-c", `python3 ${WORK}/internet.py`], cwd: WORK });
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return { code: result.exit.kind === "exited" ? result.exit.code : 128 + result.exit.signalNumber, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

function internet(context: Context): InternetConfig {
  if (context.internet === undefined) throw new Error("the harness gave no relay (run it with --internet)");
  return context.internet;
}

export async function internetConnect(context: Context): Promise<string> {
  const config = internet(context);
  await context.vm.workspace.writeText("_oxidevm/internet-ca.pem", config.root);
  await context.vm.network.connect({ kind: "server", url: config.relayUrl });
  return `the VM connected to the relay test peer (${JSON.stringify(context.vm.network.state.kind)}); the program trusts the test root through cafile=`;
}

export async function internetUrllib(context: Context): Promise<string> {
  const result = await python(context, `import socket, ssl, urllib.request
context = ssl.create_default_context(cafile='${CA}')
with urllib.request.urlopen('https://tls.test/hello', context=context, timeout=60) as response:
    print(response.status, response.read().decode().strip())
secured = context.wrap_socket(socket.create_connection(('tls.test', 443), timeout=60), server_hostname='tls.test')
certificate = secured.getpeercert()
print(secured.version(), secured.cipher()[1], secured.cipher()[0].startswith('TLS_'), certificate['subject'], certificate['subjectAltName'], certificate['issuer'])
print(len(secured.getpeercert(binary_form=True)) > 200, ssl.DER_cert_to_PEM_cert(secured.getpeercert(True)).startswith('-----BEGIN CERTIFICATE-----'))
secured.close()
`);
  const expected = "200 hello over https from tls.test/hello\nTLSv1.3 TLSv1.3 True ((('commonName', 'tls.test'),),) (('DNS', 'tls.test'),) ((('commonName', 'Pyodide Module Test Root'),),)\nTrue True\n";
  check(result.code === 0 && result.stdout === expected, `urllib over HTTPS through the relay: ${JSON.stringify(result)}`);
  return "urllib.request.urlopen('https://tls.test/hello') answered 200 through the relay; getpeercert() showed the server's subject, SAN and issuer, getpeercert(True) its DER, version() TLSv1.3 and cipher() a TLS 1.3 suite";
}

export async function internetRequests(context: Context): Promise<string> {
  const result = await python(context, `import requests
response = requests.get('https://tls.test/requests', verify='${CA}', timeout=60)
print(response.status_code, response.text.strip())
try:
    requests.get('https://tls.test/requests', timeout=60)
except requests.exceptions.SSLError as error:
    print('default verify:', 'CERTIFICATE_VERIFY_FAILED' in str(error) or repr(error))
else:
    print('default verify: accepted')
`);
  check(result.code === 0 && result.stdout === "200 hello over https from tls.test/requests\ndefault verify: True\n", `requests through the relay: ${JSON.stringify(result)}`);
  return "requests.get with verify=<the test root> answered 200 through the relay, and with requests' default (certifi's bundle, of which only what /etc/ssl/cert.pem lacks is added) the test root is not trusted: SSLError CERTIFICATE_VERIFY_FAILED";
}

export async function internetBadCertificates(context: Context): Promise<string> {
  const result = await python(context, `import socket, ssl
context = ssl.create_default_context(cafile='${CA}')
for host in ('expired.test', 'mismatch.test', 'stranger.test'):
    try:
        context.wrap_socket(socket.create_connection((host, 443), timeout=60), server_hostname=host)
        print(host, 'accepted')
    except ssl.SSLCertVerificationError as error:
        print(host, error.verify_code, error.verify_message)
`);
  const expected = "expired.test 10 certificate has expired\nmismatch.test 62 Hostname mismatch, certificate is not valid for 'mismatch.test'.\nstranger.test 20 unable to get local issuer certificate\n";
  check(result.code === 0 && result.stdout === expected, `bad certificates through the relay: ${JSON.stringify(result)}`);
  return "an expired certificate (10), one for another name (62) and one from an unknown authority (20) failed the handshake with CPython's SSLCertVerificationError codes and messages";
}

export async function internetNamesAndTimeouts(context: Context): Promise<string> {
  const result = await python(context, `import _socket, socket, time
for call in (lambda: socket.getaddrinfo('missing.test', 443), lambda: _socket.getaddrinfo('missing.test', 443), lambda: socket.socket().connect(('missing.test', 443))):
    try:
        call()
    except socket.gaierror as error:
        print(error.errno, end=' ')
print()
print(socket.gethostbyname('tls.test'))
connection = socket.create_connection(('silent.test', 443), timeout=60)
connection.settimeout(1.5)
began = time.monotonic()
try:
    connection.recv(10)
except TimeoutError as error:
    print(error, 1.4 < time.monotonic() - began < 30)
`);
  check(result.code === 0 && result.stdout === "-2 -2 -2 \n93.184.215.14\ntimed out True\n", `names and timeouts through the relay: ${JSON.stringify(result)}`);
  return "an unknown name is socket.gaierror -2 from getaddrinfo, from the C library's getaddrinfo (networkImports) and from connect; settimeout(1.5) ended a recv from a silent server with TimeoutError('timed out')";
}

export async function internetInterruptRecv(context: Context): Promise<string> {
  await context.vm.workspace.writeText("_oxidevm/internet-waits.py", "import socket\nconnection = socket.create_connection(('silent.test', 443))\nprint('connected', flush=True)\nconnection.recv(10)\n");
  const handle = await context.vm.spawn({ command: "/bin/sh", args: ["-i"], cwd: WORK, terminal: { columns: 100, rows: 30 } });
  const writer = handle.stdin.getWriter(), output = new Capture(handle.output);
  await writer.write(encoder.encode(`NO_COLOR=1 python3 ${WORK}/internet-waits.py\n`));
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
  check(shown.includes("s2=130") && shown.includes("connection.recv(10)"), `Ctrl+C during an internet recv: ${JSON.stringify(shown.slice(-800))}`);
  return "Ctrl+C during a recv from a silent internet server raised KeyboardInterrupt and ended python3 by SIGINT (130)";
}

export async function internetDisconnected(context: Context): Promise<string> {
  await context.vm.network.disconnect();
  const result = await python(context, `import errno, urllib.request, urllib.error
try:
    urllib.request.urlopen('https://tls.test/hello', timeout=60)
except urllib.error.URLError as error:
    print(type(error.reason).__name__, error.reason.errno == errno.EPERM)
`);
  check(result.code === 0 && result.stdout === "PermissionError True\n", `after disconnect: ${JSON.stringify(result)}`);
  return "after vm.network.disconnect() the VM is local-only again: urllib fails with URLError(PermissionError EPERM)";
}

export const INTERNET_SCENARIOS: readonly (readonly [name: string, run: (context: Context) => Promise<string>])[] = [
  ["internet: the VM connects through the relay test peer", internetConnect],
  ["internet: urllib over HTTPS, with the server's certificate, version and cipher", internetUrllib],
  ["internet: requests over HTTPS with verify=, and its default refuses the test root", internetRequests],
  ["internet: expired, wrong-name and unknown-authority certificates fail as in CPython", internetBadCertificates],
  ["internet: unknown names and socket timeouts", internetNamesAndTimeouts],
  ["internet: Ctrl+C ends a recv from an internet server", internetInterruptRecv],
  ["internet: after disconnect, local-only again", internetDisconnected],
];
