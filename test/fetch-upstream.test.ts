import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncUpstream, UpstreamError } from "../scripts/fetch-upstream.ts";
import type { Fetcher } from "../scripts/fetch-upstream.ts";
import { decodeUpstreamLock } from "../scripts/upstream-lock.ts";
import type { UpstreamLock } from "../scripts/upstream-lock.ts";

const encoder = new TextEncoder();
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const CONTENT: Readonly<Record<string, string>> = { "runtime.wasm": "wasm bytes", "six-1.whl": "a wheel", "pandas-3.whl": "another wheel" };

function lockOf(content: Readonly<Record<string, string>>): UpstreamLock {
  return {
    pyodide: {
      version: "1",
      npm: { package: "pyodide", version: "1", tarball: "https://registry.example/p.tgz", integrity: `sha512-${"A".repeat(86)}==` },
      source: { repository: "https://example.com/pyodide", tag: "1", commit: "a".repeat(40) },
    },
    files: Object.entries(content).map(([name, text]) => {
      const bytes = encoder.encode(text);
      const pin = { name, url: `https://cdn.example/${name}`, sha256: digest(bytes), bytes: bytes.length };
      return name.endsWith(".whl") ? { ...pin, role: "wheel" as const, package: name.slice(0, name.indexOf("-")), version: "1" } : { ...pin, role: "runtime" as const };
    }),
  };
}

/** A fetcher that serves `content`, recording which URLs were asked for. */
function serving(content: Readonly<Record<string, string>>, asked: string[] = []): Fetcher {
  return (url) => {
    asked.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const text = content[name];
    return Promise.resolve(text === undefined ? new Response("not found", { status: 404 }) : new Response(text));
  };
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(UpstreamError);
    return error instanceof Error ? error.message : "";
  }
  return "no failure";
}

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "pyodide-upstream-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("syncUpstream", () => {
  it("downloads every missing file and writes exactly the pinned bytes", async () => {
    const asked: string[] = [];
    const report = await syncUpstream({ lock: lockOf(CONTENT), directory: join(directory, "upstream"), fetcher: serving(CONTENT, asked) });
    expect(report).toEqual({ present: [], copied: [], fetched: ["runtime.wasm", "six-1.whl", "pandas-3.whl"] });
    expect(asked).toEqual(["https://cdn.example/runtime.wasm", "https://cdn.example/six-1.whl", "https://cdn.example/pandas-3.whl"]);
    for (const [name, text] of Object.entries(CONTENT)) expect(await readFile(join(directory, "upstream", name), "utf8")).toBe(text);
    expect((await readdir(join(directory, "upstream"))).sort()).toEqual(Object.keys(CONTENT).sort());
  });

  it("downloads nothing when every file is in place", async () => {
    await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT) });
    const asked: string[] = [];
    const report = await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT, asked) });
    expect(report.present).toEqual(Object.keys(CONTENT));
    expect(report.fetched).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("replaces a file that differs from its pin, and says so", async () => {
    await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT) });
    await writeFile(join(directory, "six-1.whl"), "tampered!");
    await writeFile(join(directory, "runtime.wasm"), "short");
    const lines: string[] = [];
    const report = await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT), log: line => lines.push(line) });
    expect(report.fetched).toEqual(["runtime.wasm", "six-1.whl"]);
    expect(report.present).toEqual(["pandas-3.whl"]);
    expect(lines.filter(line => line.includes("does not match its pin"))).toHaveLength(2);
    expect(await readFile(join(directory, "six-1.whl"), "utf8")).toBe("a wheel");
  });

  it("refuses a download whose hash differs and leaves no file behind", async () => {
    const wrong = { ...CONTENT, "six-1.whl": "a wheeL" };
    const message = await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(wrong) }));
    expect(message).toContain("six-1.whl");
    expect(message).toContain("sha256");
    expect((await readdir(directory)).sort()).toEqual(["runtime.wasm"]);
  });

  it("refuses a download that is longer or shorter than its pin", async () => {
    expect(await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving({ ...CONTENT, "runtime.wasm": "wasm bytes plus" }) }))).toContain("larger");
    expect(await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving({ ...CONTENT, "runtime.wasm": "wasm" }) }))).toContain("has 4 bytes");
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a response that announces more than the pin before reading it", async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response("x", { headers: { "content-length": "999" } }));
    expect(await failure(syncUpstream({ lock: lockOf({ "runtime.wasm": "x" }), directory, fetcher }))).toContain("announces 999");
  });

  it("names the file and the status when the server answers with an error", async () => {
    const message = await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving({ "runtime.wasm": CONTENT["runtime.wasm"] ?? "" }) }));
    expect(message).toContain("six-1.whl");
    expect(message).toContain("HTTP 404");
  });

  it("names the file when the request itself fails", async () => {
    const fetcher: Fetcher = () => Promise.reject(new TypeError("offline"));
    const message = await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher }));
    expect(message).toContain("runtime.wasm");
    expect(message).toContain("could not fetch");
  });

  it("gives every download a deadline", async () => {
    let signal: AbortSignal | undefined;
    const fetcher: Fetcher = (_url, given) => { signal = given; return Promise.resolve(new Response(CONTENT["runtime.wasm"] ?? "")); };
    await syncUpstream({ lock: lockOf({ "runtime.wasm": "wasm bytes" }), directory, fetcher, timeoutMs: 5000 });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("takes verified files from an existing copy before going to the network", async () => {
    const copy = await mkdtemp(join(tmpdir(), "pyodide-copy-"));
    try {
      await writeFile(join(copy, "six-1.whl"), "a wheel");
      const asked: string[] = [];
      const report = await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT, asked), from: copy });
      expect(report.copied).toEqual(["six-1.whl"]);
      expect(report.fetched).toEqual(["runtime.wasm", "pandas-3.whl"]);
      expect(asked).toEqual(["https://cdn.example/runtime.wasm", "https://cdn.example/pandas-3.whl"]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("refuses an existing copy that is not the pinned file", async () => {
    const copy = await mkdtemp(join(tmpdir(), "pyodide-copy-"));
    try {
      await writeFile(join(copy, "six-1.whl"), "not the wheel");
      const message = await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT), from: copy }));
      expect(message).toContain("six-1.whl");
      expect(message).toContain("not the pinned file");
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("only verifies in check mode, and lists everything that is missing or different", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "runtime.wasm"), CONTENT["runtime.wasm"] ?? "");
    await writeFile(join(directory, "six-1.whl"), "different");
    const asked: string[] = [];
    const message = await failure(syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT, asked), check: true }));
    expect(message).toContain("six-1.whl is different from its pin");
    expect(message).toContain("pandas-3.whl is missing");
    expect(message).not.toContain("runtime.wasm");
    expect(asked).toEqual([]);
    expect(await readFile(join(directory, "six-1.whl"), "utf8")).toBe("different");
  });

  it("passes check mode when everything matches", async () => {
    await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving(CONTENT) });
    expect((await syncUpstream({ lock: lockOf(CONTENT), directory, fetcher: serving({}), check: true })).present).toHaveLength(3);
  });
});

describe("decodeUpstreamLock", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const committed = async (): Promise<string> => readFile(join(root, "upstream/lock.json"), "utf8");

  it("reads the committed lock", async () => {
    const lock = decodeUpstreamLock(await committed());
    expect(lock.pyodide.version).toBe("314.0.7");
    expect(lock.files.filter(file => file.role === "runtime").map(file => file.name)).toEqual(["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]);
    expect(lock.files.filter(file => file.role === "wheel")).toHaveLength(13);
  });

  it("refuses unknown fields, bad hashes, repeated names and insecure URLs", async () => {
    const lock = decodeUpstreamLock(await committed());
    const [first, second, ...rest] = lock.files;
    if (first === undefined || second === undefined) throw new Error("the committed lock lists fewer than two files");
    const base = { schemaVersion: 1, pyodide: lock.pyodide, files: lock.files };
    const withFiles = (...files: readonly unknown[]): string => JSON.stringify({ ...base, files: [...files, ...rest] });
    expect(() => decodeUpstreamLock(JSON.stringify({ ...base, extra: 1 }))).toThrow("unknown field extra");
    expect(() => decodeUpstreamLock(JSON.stringify({ ...base, schemaVersion: 2 }))).toThrow("schemaVersion");
    expect(() => decodeUpstreamLock(JSON.stringify({ ...base, files: [] }))).toThrow("files");
    expect(() => decodeUpstreamLock(withFiles({ ...first, sha256: "ABC" }, second))).toThrow("sha256");
    expect(() => decodeUpstreamLock(withFiles({ ...first, url: "http://cdn.example/x" }, second))).toThrow("https");
    expect(() => decodeUpstreamLock(withFiles(first, { ...second, name: first.name }))).toThrow("twice");
    expect(() => decodeUpstreamLock(withFiles({ ...first, name: "../escape" }, second))).toThrow("name");
    expect(() => decodeUpstreamLock(withFiles({ ...first, bytes: 0 }, second))).toThrow("bytes");
    expect(() => decodeUpstreamLock(withFiles({ ...first, role: "other" }, second))).toThrow("role");
    expect(() => decodeUpstreamLock(withFiles({ ...first, extra: true }, second))).toThrow("unknown field extra");
    expect(() => decodeUpstreamLock(JSON.stringify({ ...base, pyodide: { ...lock.pyodide, source: { ...lock.pyodide.source, commit: "main" } } }))).toThrow("commit");
    expect(() => decodeUpstreamLock("{")).toThrow("not valid JSON");
  });
});

describe("the mirrored upstream files", () => {
  it("are exactly the files upstream/lock.json pins (run `pnpm run fetch-upstream` when this fails)", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const lock = decodeUpstreamLock(await readFile(join(root, "upstream/lock.json"), "utf8"));
    const report = await syncUpstream({ lock, directory: join(root, "upstream"), fetcher: () => Promise.reject(new Error("tests do not use the network")), check: true });
    expect(report.present).toHaveLength(lock.files.length);
  });
});
