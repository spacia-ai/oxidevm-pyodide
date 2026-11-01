import type { Terminals } from "@oxidevm/sdk/wasm";
import type { PyodideInterface } from "pyodide";
import type { FileDescriptor, KitErrno, SyncFiles } from "./host-types.ts";

export interface StandardStreams {
  readonly stdin: FileDescriptor;
  readonly stdout: FileDescriptor;
  readonly stderr: FileDescriptor;
}

/** The size of the process's terminal, as the VM reports it when the process starts. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const NO_TERMINALS: Terminals = { stdin: false, stdout: false, stderr: false };

/**
 * Connects Python's standard streams to the descriptors 0, 1 and 2 of this process. A read waits for the next bytes
 * (the call blocks, as a read does in any process) and returns 0 at end of input; a write reaches the descriptor before
 * Python continues, so output is never lost when the process ends. A host failure reaches Python as the `OSError` it
 * would be in any process (a closed output is a `BrokenPipeError`), because Pyodide would report anything else as EIO.
 * A descriptor is a terminal for Python (`isatty`, `os.get_terminal_size`) exactly when it is one for the process, and an
 * output terminal has the size the process's terminal had when it started (80 by 24 when that is unknown).
 */
export function attachStandardStreams(
  py: Pick<PyodideInterface, "setStdin" | "setStdout" | "setStderr"> & { readonly FS: Pick<PyodideInterface["FS"], "ErrnoError"> },
  files: Pick<SyncFiles, "read" | "writeAll">,
  streams: StandardStreams,
  errno: KitErrno,
  terminals: Terminals = NO_TERMINALS,
  size: TerminalSize | null = null,
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
  /** A writer for an output descriptor. Pyodide asks a terminal for its size (`ioctl(TIOCGWINSZ)`); other descriptors have none. */
  function writer(fd: FileDescriptor, isatty: boolean): Parameters<PyodideInterface["setStdout"]>[0] {
    const write = (bytes: Uint8Array): number => { translating(() => { files.writeAll(fd, bytes); }); return bytes.length; };
    return size === null ? { write, isatty } : { write, isatty, getTerminalSize: () => ({ columns: size.columns, rows: size.rows }) };
  }
  py.setStdin({
    read: buffer => {
      if (buffer.length === 0) return 0;
      // A host that answers with more than was asked for must not overflow the buffer Python lent us.
      const bytes = translating(() => files.read(streams.stdin, buffer.length)).subarray(0, buffer.length);
      buffer.set(bytes);
      return bytes.length;
    },
    isatty: terminals.stdin,
  });
  py.setStdout(writer(streams.stdout, terminals.stdout));
  py.setStderr(writer(streams.stderr, terminals.stderr));
}
