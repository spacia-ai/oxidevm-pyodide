import type { PyodideInterface } from "pyodide";
import type { FileDescriptor, KitErrno, SyncFiles } from "./host-types.ts";

export interface StandardStreams {
  readonly stdin: FileDescriptor;
  readonly stdout: FileDescriptor;
  readonly stderr: FileDescriptor;
}

/**
 * Connects Python's standard streams to the descriptors 0, 1 and 2 of this process. A read waits for the next bytes
 * (the call blocks, as a read does in any process) and returns 0 at end of input; a write reaches the descriptor before
 * Python continues, so output is never lost when the process ends. A host failure reaches Python as the `OSError` it
 * would be in any process (a closed output is a `BrokenPipeError`), because Pyodide would report anything else as EIO.
 */
export function attachStandardStreams(
  py: Pick<PyodideInterface, "setStdin" | "setStdout" | "setStderr"> & { readonly FS: Pick<PyodideInterface["FS"], "ErrnoError"> },
  files: Pick<SyncFiles, "read" | "writeAll">,
  streams: StandardStreams,
  errno: KitErrno,
): void {
  function translating<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error: unknown) {
      const linuxErrno = errno.of(error);
      if (linuxErrno === undefined) throw error;
      throw new py.FS.ErrnoError(errno.toEmscripten(linuxErrno));
    }
  }
  py.setStdin({
    read: buffer => {
      if (buffer.length === 0) return 0;
      // A host that answers with more than was asked for must not overflow the buffer Python lent us.
      const bytes = translating(() => files.read(streams.stdin, buffer.length)).subarray(0, buffer.length);
      buffer.set(bytes);
      return bytes.length;
    },
  });
  py.setStdout({ write: bytes => { translating(() => { files.writeAll(streams.stdout, bytes); }); return bytes.length; } });
  py.setStderr({ write: bytes => { translating(() => { files.writeAll(streams.stderr, bytes); }); return bytes.length; } });
}
