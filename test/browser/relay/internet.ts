// The "internet" of the internet scenarios: a throwaway PKI made with openssl for each run (no key in Git), HTTPS servers
// on loopback with a good, an expired, a wrong-name and a stranger's certificate, a plain HTTP server, and a TCP server
// that never answers. The relay test peer (./peer.ts) routes public addresses to them and its DNS names them, so the
// module reaches them only through the VM's relay connection. Adapted from oxidevm-sdk (Apache-2.0)
// packages/sdk/src/wasm/net/tls-pki.test-support.ts and tests/browser/wasm-network/servers.ts.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RelayRoute } from "./peer.ts";

const run = promisify(execFile);

interface Identity { readonly key: string; readonly cert: string }

/** The names the peer's DNS answers, each with the public address the peer routes to its server. */
export const HOSTS = {
  good: { name: "tls.test", address: "93.184.215.14" },
  expired: { name: "expired.test", address: "93.184.215.15" },
  mismatch: { name: "mismatch.test", address: "93.184.215.16" },
  stranger: { name: "stranger.test", address: "93.184.215.17" },
  silent: { name: "silent.test", address: "93.184.215.18" },
} as const;

export interface Internet {
  /** The root the program trusts (`cafile=`), PEM. */
  readonly root: string;
  readonly routes: readonly RelayRoute[];
  readonly dns: ReadonlyMap<string, readonly string[]>;
  /** Every request, as `<scheme> <host> <path>`. */
  readonly requests: string[];
  close(): Promise<void>;
}

/** A root, and leaves for tls.test (good), expired.test (expired), other.test (served as mismatch.test) and a stranger root's tls.test. */
async function createPki(): Promise<{ readonly root: string; readonly good: Identity; readonly expired: Identity; readonly mismatch: Identity; readonly stranger: Identity }> {
  const directory = await mkdtemp(join(tmpdir(), "pyodide-internet-pki-"));
  const path = (name: string): string => join(directory, name);
  const openssl = (...args: string[]): Promise<unknown> => run("openssl", args, { timeout: 30_000, cwd: directory });
  const key = (name: string): Promise<unknown> => openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path(`${name}.key`));
  const root = async (name: string, subject: string): Promise<void> => {
    await key(name);
    await openssl("req", "-x509", "-new", "-key", path(`${name}.key`), "-subj", `/CN=${subject}`, "-days", "30",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", path(`${name}.pem`));
  };
  const leaf = async (name: string, issuer: string, dns: string, window: readonly string[]): Promise<Identity> => {
    await key(name);
    await openssl("req", "-new", "-key", path(`${name}.key`), "-subj", `/CN=${dns}`, "-out", path(`${name}.csr`));
    await writeFile(path(`${name}.ext`), `subjectAltName=DNS:${dns}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n`);
    await openssl("x509", "-req", "-in", path(`${name}.csr`), "-CA", path(`${issuer}.pem`), "-CAkey", path(`${issuer}.key`), "-set_serial", `0x${Date.now().toString(16)}${name.length.toString(16)}`,
      ...window, "-extfile", path(`${name}.ext`), "-out", path(`${name}.pem`));
    return { key: await readFile(path(`${name}.key`), "utf8"), cert: await readFile(path(`${name}.pem`), "utf8") };
  };
  try {
    await root("root", "Pyodide Module Test Root");
    await root("stranger", "Pyodide Module Test Stranger");
    const valid = ["-days", "30"];
    return {
      root: await readFile(path("root.pem"), "utf8"),
      good: await leaf("good", "root", HOSTS.good.name, valid),
      expired: await leaf("expired", "root", HOSTS.expired.name, ["-not_before", "20200101000000Z", "-not_after", "20210101000000Z"]),
      mismatch: await leaf("mismatch", "root", "other.test", valid),
      stranger: await leaf("stranger-leaf", "stranger", HOSTS.stranger.name, valid),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((ready, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") fail(new Error("no port")); else ready(address.port);
    });
  });
}

export async function startInternet(): Promise<Internet> {
  const pki = await createPki();
  const requests: string[] = [];
  const handle = (scheme: string) => (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    requests.push(`${scheme} ${request.headers.host ?? "-"} ${path}`);
    response.writeHead(200, { "Content-Type": "text/plain" }).end(`hello over ${scheme} from ${request.headers.host ?? "-"}${path}\n`);
  };
  const https = Object.fromEntries((["good", "expired", "mismatch", "stranger"] as const).map(kind => [kind, createHttpsServer(pki[kind], handle("https"))]));
  const http = createHttpServer(handle("http"));
  const held: Socket[] = [];
  const silent = createTcpServer(socket => { held.push(socket); });
  const ports = new Map<string, number>();
  for (const [kind, server] of Object.entries(https)) ports.set(kind, await listen(server));
  const httpPort = await listen(http), silentPort = await listen(silent);
  const port = (kind: string): number => ports.get(kind) ?? 0;
  const routes: RelayRoute[] = [
    { address: HOSTS.good.address, ports: new Map([[443, port("good")], [80, httpPort]]) },
    { address: HOSTS.expired.address, ports: new Map([[443, port("expired")]]) },
    { address: HOSTS.mismatch.address, ports: new Map([[443, port("mismatch")]]) },
    { address: HOSTS.stranger.address, ports: new Map([[443, port("stranger")]]) },
    { address: HOSTS.silent.address, ports: new Map([[443, silentPort]]) },
  ];
  const dns = new Map(Object.values(HOSTS).map(host => [host.name, [host.address]]));
  const close = (server: Server | ReturnType<typeof createTcpServer>): Promise<void> => new Promise(done => { server.close(() => { done(); }); if ("closeAllConnections" in server) server.closeAllConnections(); });
  return {
    root: pki.root, routes, dns, requests,
    close: async () => {
      for (const socket of held) socket.destroy();
      await Promise.all([...Object.values(https), http, silent].map(close));
    },
  };
}

/** A self-signed certificate for 127.0.0.1, the relay peer's HTTPS and WSS identity; the key never leaves the run. */
export async function relayIdentity(): Promise<Identity> {
  const directory = await mkdtemp(join(tmpdir(), "pyodide-relay-identity-"));
  try {
    await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "2"], { timeout: 30_000 });
    return { key: await readFile(join(directory, "key.pem"), "utf8"), cert: await readFile(join(directory, "cert.pem"), "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
