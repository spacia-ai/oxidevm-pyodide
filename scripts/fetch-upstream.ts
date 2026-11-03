// Mirrors the upstream files the release carries into upstream/, byte for byte, and refuses anything that does not
// match upstream/lock.json. The files are not committed (they are about 29 MB); the release build pins them again.
//
//   node scripts/fetch-upstream.ts                 download what is missing or damaged
//   node scripts/fetch-upstream.ts --from <dir>    take files from an existing copy first (verified the same way)
//   node scripts/fetch-upstream.ts --check         verify only, and fail when anything is missing or different
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodeUpstreamLock } from "./upstream-lock.ts";
import type { PinnedFile, UpstreamLock } from "./upstream-lock.ts";

export type Fetcher = (url: string, signal: AbortSignal) => Promise<Response>;

export interface SyncOptions {
  readonly lock: UpstreamLock;
  /** Where the files go (the repository's upstream/ directory). */
  readonly directory: string;
  readonly fetcher: Fetcher;
  /** A directory that may already hold some of the files. */
  readonly from?: string;
  /** Verify what is there and download nothing. */
  readonly check?: boolean;
  /** How long one download may take; defaults to two minutes. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface SyncReport {
  /** Files that were already in place and correct. */
  readonly present: readonly string[];
  /** Files taken from the `from` directory. */
  readonly copied: readonly string[];
  /** Files downloaded. */
  readonly fetched: readonly string[];
}

/** A file that is missing, damaged or different from its pin. */
export class UpstreamError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

/** Reads a file and returns its bytes only when they are exactly what the pin says. */
async function readPinned(path: string, pin: PinnedFile): Promise<Uint8Array<ArrayBuffer> | "missing" | "different"> {
  let content: Uint8Array<ArrayBuffer>;
  try {
    content = new Uint8Array(await readFile(path));
  } catch (error: unknown) {
    if (isMissing(error)) return "missing";
    throw error;
  }
  return content.length === pin.bytes && sha256(content) === pin.sha256 ? content : "different";
}

/** Reads a response body, never holding more than `limit` bytes, and refuses one that is not exactly `pin.bytes` long. */
async function readBody(response: Response, pin: PinnedFile): Promise<Uint8Array<ArrayBuffer>> {
  // With a content coding (a CDN may send a wheel brotli-encoded), Content-Length counts the encoded bytes, not the file's;
  // the read below still refuses more than the pinned length.
  const encoding = response.headers.get("content-encoding");
  const declared = encoding === null || encoding.trim().toLowerCase() === "identity" ? response.headers.get("content-length") : null;
  if (declared !== null && Number(declared) > pin.bytes) throw new UpstreamError(`${pin.name}: the server announces ${declared} bytes, more than the ${String(pin.bytes)} pinned`);
  if (response.body === null) throw new UpstreamError(`${pin.name}: the response has no body`);
  const bytes = new Uint8Array(pin.bytes);
  const reader = response.body.getReader();
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (length + part.value.length > pin.bytes) {
      await reader.cancel();
      throw new UpstreamError(`${pin.name}: the download is larger than the ${String(pin.bytes)} bytes pinned`);
    }
    bytes.set(part.value, length);
    length += part.value.length;
  }
  if (length !== pin.bytes) throw new UpstreamError(`${pin.name}: the download has ${String(length)} bytes, not the ${String(pin.bytes)} pinned`);
  return bytes;
}

async function download(pin: PinnedFile, fetcher: Fetcher, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
  let response: Response;
  try {
    response = await fetcher(pin.url, AbortSignal.timeout(timeoutMs));
  } catch (error: unknown) {
    throw new UpstreamError(`${pin.name}: could not fetch ${pin.url}`, { cause: error });
  }
  if (!response.ok) throw new UpstreamError(`${pin.name}: ${pin.url} answered HTTP ${String(response.status)}`);
  const bytes = await readBody(response, pin);
  const actual = sha256(bytes);
  if (actual !== pin.sha256) throw new UpstreamError(`${pin.name}: sha256 is ${actual}, not the ${pin.sha256} pinned`);
  return bytes;
}

/** Writes beside the target and renames, so that a file is either absent or complete. */
async function place(target: string, bytes: Uint8Array): Promise<void> {
  const partial = `${target}.part`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Brings the directory in line with the lock, or, with `check`, reports how far it is from it. */
export async function syncUpstream(options: SyncOptions): Promise<SyncReport> {
  const log = options.log ?? (() => undefined);
  const present: string[] = [], copied: string[] = [], fetched: string[] = [], problems: string[] = [];
  if (options.check !== true) await mkdir(options.directory, { recursive: true });
  for (const pin of options.lock.files) {
    const target = join(options.directory, pin.name);
    const current = await readPinned(target, pin);
    if (typeof current !== "string") {
      present.push(pin.name);
      continue;
    }
    if (options.check === true) {
      problems.push(`${pin.name} is ${current === "missing" ? "missing" : "different from its pin"}`);
      continue;
    }
    if (current === "different") log(`${pin.name} does not match its pin; replacing it`);
    const local = options.from === undefined ? "missing" : await readPinned(join(options.from, pin.name), pin);
    if (typeof local !== "string") {
      await place(target, local);
      copied.push(pin.name);
      log(`copied ${pin.name}`);
      continue;
    }
    if (local === "different") throw new UpstreamError(`${pin.name}: the copy in ${options.from ?? ""} is not the pinned file`);
    await place(target, await download(pin, options.fetcher, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    fetched.push(pin.name);
    log(`fetched ${pin.name}`);
  }
  if (problems.length > 0) throw new UpstreamError(`upstream/ does not match upstream/lock.json:\n  ${problems.join("\n  ")}\nRun: pnpm run fetch-upstream`);
  return { present, copied, fetched };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { from: { type: "string" }, check: { type: "boolean" } }, strict: true });
  const root = resolve(import.meta.dirname, "..");
  try {
    const lock = decodeUpstreamLock(await readFile(join(root, "upstream/lock.json"), "utf8"));
    const report = await syncUpstream({
      lock, directory: join(root, "upstream"), fetcher: (url, signal) => fetch(url, { signal }), check: values.check === true,
      ...(values.from === undefined ? {} : { from: resolve(values.from) }), log: line => { process.stdout.write(`${line}\n`); },
    });
    process.stdout.write(`${String(lock.files.length)} files pinned: ${String(report.present.length)} present, ${String(report.copied.length)} copied, ${String(report.fetched.length)} downloaded\n`);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
