/** The signature of the global `fetch`, which is what Pyodide calls to read its own files. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The part of a global scope that holds `fetch`; tests pass a plain object. */
export interface FetchScope {
  fetch: Fetch;
}

/**
 * The files Pyodide may read, already verified against the release pins. `index` is the virtual address they appear
 * under; nothing is ever requested from it, and it ends in `.invalid`, which no resolver answers. `read` answers for a
 * served file name with its bytes (read only when Pyodide asks for it), and with undefined for any other name.
 */
export interface ServedFiles {
  readonly index: string;
  readonly read: (name: string) => Promise<Uint8Array<ArrayBuffer>> | undefined;
  /** WebAssembly files the VM already compiled: served as an empty response that names them in `PRECOMPILED_HEADER`. */
  readonly precompiled?: ReadonlySet<string>;
}

/**
 * The header of a WebAssembly file that is served without its bytes because the VM already compiled it: whoever
 * instantiates the response instantiates that module instead (`withPrecompiledWasm` in src/python-loader.ts).
 */
export const PRECOMPILED_HEADER = "x-oxidevm-precompiled";

export const VIRTUAL_INDEX = "https://pyodide.invalid/";

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["wasm", "application/wasm"],
  ["zip", "application/zip"],
  ["whl", "application/zip"],
  ["json", "application/json"],
]);

/** The type a response needs so that `WebAssembly.instantiateStreaming` and Pyodide's loaders accept it. */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES.get(name.slice(dot + 1))) ?? "application/octet-stream";
}

function addressOf(input: RequestInfo | URL): URL | undefined {
  const text = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(text);
  } catch {
    // A relative reference resolves against the worker, never against the virtual host.
    return undefined;
  }
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function fileNameOf(address: URL, index: URL): string | undefined {
  // The only accepted spelling has no user name, query or fragment, so those variants cannot reach a file by accident.
  if (address.href !== `${address.origin}${address.pathname}` || address.origin !== index.origin || !address.pathname.startsWith(index.pathname)) return undefined;
  try {
    return decodeURIComponent(address.pathname.slice(index.pathname.length));
  } catch {
    return undefined;
  }
}

/**
 * A `fetch` that answers for the virtual host and nothing else. Pyodide is told to find its files there because a
 * bundler renames the staged files, so it cannot read siblings of a real directory. Each answer is built from bytes
 * the release pins already vouch for. A request to the virtual host for anything that is not a served file is rejected,
 * and every other request goes to `passthrough` untouched.
 */
export function scopedFetch(served: ServedFiles, passthrough: Fetch): Fetch {
  const index = new URL(served.index);
  return (input, init) => {
    const address = addressOf(input);
    if (address?.hostname !== index.hostname) return passthrough(input, init);
    const refuse = (reason: string): Promise<Response> => Promise.reject(new TypeError(`${address.href} ${reason}`));
    const cancelled = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (cancelled?.aborted === true) return Promise.reject(cancelled.reason instanceof Error ? cancelled.reason : new TypeError("The request was cancelled"));
    if (methodOf(input, init) !== "GET") return refuse("can only be read");
    const name = fileNameOf(address, index);
    if (name !== undefined && served.precompiled?.has(name) === true) {
      return Promise.resolve(new Response(null, { status: 200, headers: { "content-type": contentTypeFor(name), [PRECOMPILED_HEADER]: name } }));
    }
    const reading = name === undefined ? undefined : served.read(name);
    if (name === undefined || reading === undefined) return refuse("is not an artifact of the pyodide module");
    return reading.then(bytes => new Response(bytes, { status: 200, headers: { "content-type": contentTypeFor(name), "content-length": String(bytes.length) } }));
  };
}

/**
 * Runs `work` with the scope's `fetch` replaced by `scopedFetch`, then puts the original back, whether `work` succeeds or
 * fails. A `fetch` that something else installed in the meantime is left alone.
 */
export async function withScopedFetch<T>(scope: FetchScope, served: ServedFiles, work: () => Promise<T>): Promise<T> {
  const original = scope.fetch;
  const scoped = scopedFetch(served, (input, init) => original.call(scope, input, init));
  scope.fetch = scoped;
  try {
    return await work();
  } finally {
    if (scope.fetch === scoped) scope.fetch = original;
  }
}
