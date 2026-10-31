// `pyodide.d.ts` names two types from Node. The module's own program has no Node types (an adapter runs in a worker),
// so it declares what those names mean there. The test and script programs have the real Node types and exclude this file.

type WebReadableStream<R> = ReadableStream<R>;
type WebWritableStream<W> = WritableStream<W>;

/** A worker has the web streams, which have the shape `pyodide.d.ts` expects. */
declare module "node:stream/web" {
  export type ReadableStream<R = unknown> = WebReadableStream<R>;
  export type WritableStream<W = unknown> = WebWritableStream<W>;
}

/** `pyodide.d.ts` accepts a Node socket in its Node-only socket support. A worker never has one, so it is opaque here. */
declare module "node:net" {
  export type Socket = object;
}
