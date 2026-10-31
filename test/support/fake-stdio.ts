import type { SyncFiles } from "../../src/host-types.ts";
import { descriptor } from "./brands.ts";

/** The process's descriptors 0, 1 and 2 in memory: a test feeds standard input and reads what Python wrote. */
export interface FakeStdio {
  readonly files: Pick<SyncFiles, "read" | "writeAll">;
  readonly streams: { readonly stdin: ReturnType<typeof descriptor>; readonly stdout: ReturnType<typeof descriptor>; readonly stderr: ReturnType<typeof descriptor> };
  /** Queues text for Python's standard input, which ends once everything queued has been read. */
  feed(text: string): void;
  /** The text written to standard output and standard error since the last call. */
  take(): { readonly stdout: string; readonly stderr: string };
  /** The sizes of the individual writes to standard output, to check that output is not held back. */
  readonly writes: number[];
}

export function fakeStdio(): FakeStdio {
  let input = new Uint8Array(0);
  const out: Uint8Array[] = [], err: Uint8Array[] = [], writes: number[] = [];
  const decode = (chunks: Uint8Array[]): string => {
    const all = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(all);
  };
  return {
    streams: { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2) },
    files: {
      read(_fd, count) {
        const bytes = input.slice(0, count);
        input = input.slice(count);
        return bytes;
      },
      writeAll(fd, bytes) {
        if (fd === 1) writes.push(bytes.length);
        (fd === 1 ? out : err).push(bytes.slice());
      },
    },
    feed(text) {
      const added = new TextEncoder().encode(text);
      const all = new Uint8Array(input.length + added.length);
      all.set(input);
      all.set(added, input.length);
      input = all;
    },
    take() {
      const result = { stdout: decode(out), stderr: decode(err) };
      out.length = 0;
      err.length = 0;
      return result;
    },
    writes,
  };
}
