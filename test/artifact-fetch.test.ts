import { describe, expect, it } from "vitest";
import { contentTypeFor, PRECOMPILED_HEADER, scopedFetch, VIRTUAL_INDEX, withScopedFetch } from "../src/artifact-fetch.ts";
import type { Fetch, ServedFiles } from "../src/artifact-fetch.ts";

const WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const WHEEL = Uint8Array.of(80, 75, 3, 4, 9, 9);
const LOCK = new TextEncoder().encode('{"packages":{}}');

/** Every name `read` was asked for, in order: a file is read only when it is fetched. */
const reads: string[] = [];

function served(): ServedFiles {
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
      ["pyodide.asm.wasm", Uint8Array.from(WASM)],
      ["pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl", Uint8Array.from(WHEEL)],
      ["python_stdlib.zip", Uint8Array.from(WHEEL)],
      ["pyodide-lock.json", Uint8Array.from(LOCK)],
      ["NOTICES.txt", Uint8Array.of(65)],
  ]);
  return {
    index: VIRTUAL_INDEX,
    read: name => {
      reads.push(name);
      const bytes = files.get(name);
      return bytes === undefined ? undefined : Promise.resolve(bytes);
    },
  };
}

interface Passed { readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }

/** An original fetch that records what reached it and answers `network`. */
function recordingFetch(): { readonly fetch: Fetch; readonly passed: Passed[] } {
  const passed: Passed[] = [];
  const fetch: Fetch = (input, init) => {
    passed.push({ input, init });
    return Promise.resolve(new Response("network"));
  };
  return { fetch, passed };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the fetch to be rejected");
}

describe("contentTypeFor", () => {
  it("names the types Pyodide and the browser expect", () => {
    expect(contentTypeFor("pyodide.asm.wasm")).toBe("application/wasm");
    expect(contentTypeFor("python_stdlib.zip")).toBe("application/zip");
    expect(contentTypeFor("six-1.17.0-py2.py3-none-any.whl")).toBe("application/zip");
    expect(contentTypeFor("pyodide-lock.json")).toBe("application/json");
    expect(contentTypeFor("NOTICES.txt")).toBe("application/octet-stream");
    expect(contentTypeFor("noextension")).toBe("application/octet-stream");
  });
});

describe("scopedFetch under the virtual index", () => {
  it("reads a file only when it is fetched, once per fetch", async () => {
    reads.length = 0;
    const run = scopedFetch(served(), recordingFetch().fetch);
    expect(reads).toEqual([]);
    await run(`${VIRTUAL_INDEX}python_stdlib.zip`);
    expect(reads).toEqual(["python_stdlib.zip"]);
  });

  it("answers for a file the VM already compiled with an empty response that names it, without reading it", async () => {
    reads.length = 0;
    const run = scopedFetch({ ...served(), precompiled: new Set(["pyodide.asm.wasm"]) }, recordingFetch().fetch);
    const response = await run(`${VIRTUAL_INDEX}pyodide.asm.wasm`);
    expect([response.status, response.headers.get(PRECOMPILED_HEADER), response.headers.get("content-type"), (await response.arrayBuffer()).byteLength]).toEqual([200, "pyodide.asm.wasm", "application/wasm", 0]);
    expect(reads).toEqual([]);
    // Only the named file is answered that way.
    expect((await run(`${VIRTUAL_INDEX}python_stdlib.zip`)).headers.get(PRECOMPILED_HEADER)).toBeNull();
  });

  it("serves only under the directory of the index when the index has a path of its own", async () => {
    const { fetch, passed } = recordingFetch();
    const run = scopedFetch({ index: "https://pyodide.invalid/v1/", read: served().read }, fetch);
    expect((await run("https://pyodide.invalid/v1/pyodide.asm.wasm")).status).toBe(200);
    // "/zz/" is as long as "/v1/", so only the check of the directory keeps this from being the file.
    for (const outside of ["https://pyodide.invalid/zz/pyodide.asm.wasm", "https://pyodide.invalid/pyodide.asm.wasm", "https://pyodide.invalid/v2/pyodide.asm.wasm"]) {
      expect(await rejection(run(outside)), outside).toBeInstanceOf(TypeError);
    }
    expect(passed).toEqual([]);
  });

  it("serves a declared artifact with its bytes and type", async () => {
    const { fetch, passed } = recordingFetch();
    const response = await scopedFetch(served(), fetch)(`${VIRTUAL_INDEX}pyodide.asm.wasm`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(response.headers.get("content-length")).toBe(String(WASM.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WASM);
    expect(passed).toEqual([]);
  });

  it("serves each wheel as a zip and the lock as JSON, to a streaming consumer too", async () => {
    const run = scopedFetch(served(), recordingFetch().fetch);
    const wheel = await run(new URL(`${VIRTUAL_INDEX}pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl`));
    expect(wheel.headers.get("content-type")).toBe("application/zip");
    const lock = await run(new Request(`${VIRTUAL_INDEX}pyodide-lock.json`));
    expect(lock.headers.get("content-type")).toBe("application/json");
    expect(await lock.json()).toEqual({ packages: {} });
    // WebAssembly.instantiateStreaming accepts exactly this: a response with the wasm type.
    const module = await WebAssembly.compileStreaming(run(`${VIRTUAL_INDEX}pyodide.asm.wasm`));
    expect(module).toBeInstanceOf(WebAssembly.Module);
  });

  it("gives every response its own copy of the bytes", async () => {
    const files = served();
    const run = scopedFetch(files, recordingFetch().fetch);
    const first = new Uint8Array(await (await run(`${VIRTUAL_INDEX}python_stdlib.zip`)).arrayBuffer());
    first.fill(0);
    const second = new Uint8Array(await (await run(`${VIRTUAL_INDEX}python_stdlib.zip`)).arrayBuffer());
    expect(second).toEqual(WHEEL);
  });

  it("matches the host however the request spells it", async () => {
    const run = scopedFetch(served(), recordingFetch().fetch);
    for (const spelled of ["HTTPS://PYODIDE.INVALID/pyodide.asm.wasm", `${VIRTUAL_INDEX}a/../pyodide.asm.wasm`, `${VIRTUAL_INDEX}%70yodide.asm.wasm`]) {
      expect((await run(spelled)).status, spelled).toBe(200);
    }
  });

  it("rejects a file that is not an artifact of this module instead of answering 404", async () => {
    const { fetch, passed } = recordingFetch();
    const run = scopedFetch(served(), fetch);
    for (const url of [
      `${VIRTUAL_INDEX}scipy-1.16.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl`,
      VIRTUAL_INDEX,
      `${VIRTUAL_INDEX}sub/pyodide.asm.wasm`,
      `${VIRTUAL_INDEX}..%2Fpyodide.asm.wasm`,
      `${VIRTUAL_INDEX}%2e%2e%2fetc%2fpasswd`,
      `${VIRTUAL_INDEX}pyodide.asm.wasm?x=1`,
      `${VIRTUAL_INDEX}pyodide.asm.wasm#fragment`,
      `${VIRTUAL_INDEX}PYODIDE.ASM.WASM`,
      `${VIRTUAL_INDEX}%E0%A4%A`,
      `${VIRTUAL_INDEX}pyodide.asm.wasm%00`,
    ]) {
      const error = await rejection(run(url));
      expect(error, url).toBeInstanceOf(TypeError);
    }
    expect(passed).toEqual([]);
  });

  it("names the refused file in the error", async () => {
    const error = await rejection(scopedFetch(served(), recordingFetch().fetch)(`${VIRTUAL_INDEX}numpy-1.whl`));
    expect(error).toBeInstanceOf(TypeError);
    expect(error instanceof Error ? error.message : "").toContain("numpy-1.whl");
  });

  it("reserves the whole host, whatever the scheme or port", async () => {
    const { fetch, passed } = recordingFetch();
    const run = scopedFetch(served(), fetch);
    for (const url of ["http://pyodide.invalid/pyodide.asm.wasm", "https://pyodide.invalid:8443/pyodide.asm.wasm", "https://user@pyodide.invalid/pyodide.asm.wasm", "https://user:secret@pyodide.invalid/x"]) {
      expect(await rejection(run(url)), url).toBeInstanceOf(TypeError);
    }
    expect(passed).toEqual([]);
  });

  it("serves only reads", async () => {
    const run = scopedFetch(served(), recordingFetch().fetch);
    const url = `${VIRTUAL_INDEX}pyodide.asm.wasm`;
    expect(await rejection(run(url, { method: "POST", body: "x" }))).toBeInstanceOf(TypeError);
    expect(await rejection(run(new Request(url, { method: "PUT", body: "x" })))).toBeInstanceOf(TypeError);
    expect((await run(url, { method: "get" })).status).toBe(200);
    expect((await run(new Request(url))).status).toBe(200);
  });

  it("honours a cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const error = await rejection(scopedFetch(served(), recordingFetch().fetch)(`${VIRTUAL_INDEX}pyodide.asm.wasm`, { signal: controller.signal }));
    expect(error instanceof Error ? error.message : "").toBe("stop");
  });

  it("ignores the integrity option, because the bytes were verified against the release pin", async () => {
    const response = await scopedFetch(served(), recordingFetch().fetch)(new URL(`${VIRTUAL_INDEX}python_stdlib.zip`), { integrity: "sha256-AAAA" });
    expect(response.status).toBe(200);
  });
});

describe("scopedFetch elsewhere", () => {
  it("leaves every other URL to the original fetch, with the same arguments", async () => {
    const { fetch, passed } = recordingFetch();
    const run = scopedFetch(served(), fetch);
    const init: RequestInit = { method: "POST", body: "x" };
    for (const input of ["https://example.com/pyodide.asm.wasm", new URL("https://cdn.jsdelivr.net/pyodide/pyodide.asm.wasm"), new Request("https://example.com/x")]) {
      const response = await run(input, init);
      expect(await response.text()).toBe("network");
    }
    expect(passed.map(item => item.input)).toHaveLength(3);
    expect(passed.every(item => item.init === init)).toBe(true);
    expect(passed[0]?.input).toBe("https://example.com/pyodide.asm.wasm");
  });

  it("does not mistake a lookalike host for the virtual one", async () => {
    const { fetch, passed } = recordingFetch();
    const run = scopedFetch(served(), fetch);
    for (const url of ["https://pyodide.invalid.example.com/pyodide.asm.wasm", "https://notpyodide.invalid/pyodide.asm.wasm", "https://example.com/pyodide.invalid/pyodide.asm.wasm"]) {
      expect(await (await run(url)).text(), url).toBe("network");
    }
    expect(passed).toHaveLength(3);
  });

  it("passes relative references on, because they resolve against the worker and never to the virtual host", async () => {
    const { fetch, passed } = recordingFetch();
    expect(await (await scopedFetch(served(), fetch)("relative/file.bin")).text()).toBe("network");
    expect(passed).toHaveLength(1);
  });
});

describe("withScopedFetch", () => {
  it("serves during the work and restores the original afterwards", async () => {
    const { fetch, passed } = recordingFetch();
    const scope: { fetch: Fetch } = { fetch };
    const inside = await withScopedFetch(scope, served(), async () => {
      expect(scope.fetch).not.toBe(fetch);
      const virtual = await scope.fetch(`${VIRTUAL_INDEX}pyodide.asm.wasm`);
      const other = await scope.fetch("https://example.com/x");
      return [virtual.status, await other.text()];
    });
    expect(inside).toEqual([200, "network"]);
    expect(scope.fetch).toBe(fetch);
    expect(passed).toHaveLength(1);
  });

  it("restores the original when the work fails, and rethrows the failure unchanged", async () => {
    const { fetch } = recordingFetch();
    const scope: { fetch: Fetch } = { fetch };
    const failure = new Error("loading failed");
    const error = await rejection(withScopedFetch(scope, served(), () => Promise.reject(failure)));
    expect(error).toBe(failure);
    expect(scope.fetch).toBe(fetch);
  });

  it("restores the original when the work throws synchronously", async () => {
    const { fetch } = recordingFetch();
    const scope: { fetch: Fetch } = { fetch };
    const error = await rejection(withScopedFetch(scope, served(), () => { throw new Error("sync"); }));
    expect(error instanceof Error ? error.message : "").toBe("sync");
    expect(scope.fetch).toBe(fetch);
  });

  it("no longer serves the virtual host once the work is done", async () => {
    const { fetch, passed } = recordingFetch();
    const scope: { fetch: Fetch } = { fetch };
    await withScopedFetch(scope, served(), () => Promise.resolve());
    expect(await (await scope.fetch(`${VIRTUAL_INDEX}pyodide.asm.wasm`)).text()).toBe("network");
    expect(passed).toHaveLength(1);
  });

  it("leaves alone a fetch that someone else installed meanwhile", async () => {
    const { fetch } = recordingFetch();
    const scope: { fetch: Fetch } = { fetch };
    const theirs: Fetch = () => Promise.resolve(new Response("theirs"));
    await withScopedFetch(scope, served(), () => { scope.fetch = theirs; return Promise.resolve(); });
    expect(scope.fetch).toBe(theirs);
  });
});
