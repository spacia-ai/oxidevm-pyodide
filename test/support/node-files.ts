import * as nodeFs from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { kit } from "@oxidevm/sdk/wasm";
import type { FileDescriptor, SyncFiles } from "../../src/host-types.ts";

/**
 * A stand-in for the VM's synchronous file API that works on a directory of the test machine: `/workspace` is `root`.
 * It fails the way the host does, with a `LinuxError` that carries the Linux errno, and it keeps file positions the
 * way a file descriptor does, because Node has no `lseek`.
 */
export interface NodeFiles {
  readonly files: SyncFiles;
  /** The real path behind a VM path. */
  readonly real: (path: string) => string;
  /** How many descriptors are still open. */
  readonly openDescriptors: () => number;
  /** Every call made, as `operation path` lines, for tests that check what reached the host. */
  readonly calls: string[];
}

const WORKSPACE = "/workspace";

/** The host's descriptors are branded numbers; a predicate is how a plain number earns the brand without an assertion. */
function isDescriptor(value: number): value is FileDescriptor {
  return Number.isSafeInteger(value) && value >= 0;
}
function asDescriptor(value: number): FileDescriptor {
  if (!isDescriptor(value)) throw new LinuxError(9);
  return value;
}

export function nodeFiles(root: string): NodeFiles {
  const calls: string[] = [];
  const positions = new Map<number, number>();

  function real(path: string): string {
    if (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`)) throw new LinuxError(2);
    return join(root, path.slice(WORKSPACE.length));
  }
  function linuxError(error: unknown): never {
    const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
    const errno: unknown = typeof code === "string" ? Reflect.get(constants.errno, code) : undefined;
    throw new LinuxError(typeof errno === "number" ? errno : 5);
  }
  function guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error: unknown) {
      return linuxError(error);
    }
  }
  const text = (path: string | Uint8Array): string => (typeof path === "string" ? path : new TextDecoder().decode(path));
  const toStat = (found: nodeFs.BigIntStats): ReturnType<SyncFiles["stat"]> => ({
    device: found.dev, inode: found.ino, links: found.nlink, mode: Number(found.mode), uid: Number(found.uid), gid: Number(found.gid),
    size: found.size, accessedNs: found.atimeNs, modifiedNs: found.mtimeNs, changedNs: found.ctimeNs,
  });

  const files: SyncFiles = {
    open(path, flags = 0, mode = 0o666) {
      calls.push(`open ${text(path)}`);
      const fd = guard(() => nodeFs.openSync(real(text(path)), flags, mode));
      positions.set(fd, 0);
      return asDescriptor(fd);
    },
    close(fd) {
      calls.push(`close ${String(fd)}`);
      positions.delete(fd);
      guard(() => { nodeFs.closeSync(fd); });
    },
    read(fd, count) {
      const position = positions.get(fd) ?? 0;
      const buffer = Buffer.alloc(count);
      const read = guard(() => nodeFs.readSync(fd, buffer, 0, count, position));
      positions.set(fd, position + read);
      return Uint8Array.from(buffer.subarray(0, read));
    },
    write(fd, bytes) {
      const position = positions.get(fd) ?? 0;
      const written = guard(() => nodeFs.writeSync(fd, bytes, 0, bytes.length, position));
      positions.set(fd, position + written);
      return written;
    },
    writeAll(fd, bytes) {
      let offset = 0;
      while (offset < bytes.length) offset += files.write(fd, bytes.subarray(offset));
    },
    seek(fd, offset, origin = "start") {
      const base = origin === "end" ? guard(() => nodeFs.fstatSync(fd).size) : origin === "current" ? positions.get(fd) ?? 0 : 0;
      const position = base + Number(offset);
      if (position < 0) throw new LinuxError(22);
      positions.set(fd, position);
      return BigInt(position);
    },
    fstat: fd => toStat(guard(() => nodeFs.fstatSync(fd, { bigint: true }))),
    stat: path => toStat(guard(() => nodeFs.statSync(real(text(path)), { bigint: true }))),
    lstat: path => toStat(guard(() => nodeFs.lstatSync(real(text(path)), { bigint: true }))),
    // The real host lists "." and ".." too, which is why the bridge filters them.
    readdir: path => [".", "..", ...guard(() => nodeFs.readdirSync(real(text(path))))].map(name => ({ name, nameBytes: new TextEncoder().encode(name), type: 0 })),
    mkdir(path, mode = 0o777) { calls.push(`mkdir ${text(path)}`); guard(() => { nodeFs.mkdirSync(real(text(path)), { mode }); }); },
    rename(from, to) { calls.push(`rename ${text(from)} ${text(to)}`); guard(() => { nodeFs.renameSync(real(text(from)), real(text(to))); }); },
    unlink(path, directory = false) {
      calls.push(`${directory ? "rmdir" : "unlink"} ${text(path)}`);
      guard(() => { if (directory) nodeFs.rmdirSync(real(text(path))); else nodeFs.unlinkSync(real(text(path))); });
    },
    chmod(path, mode) { calls.push(`chmod ${text(path)}`); guard(() => { nodeFs.chmodSync(real(text(path)), mode & 0o7777); }); },
    fchmod(fd, mode) { guard(() => { nodeFs.fchmodSync(fd, mode & 0o7777); }); },
    truncate(path, length) { calls.push(`truncate ${text(path)} ${String(length)}`); guard(() => { nodeFs.truncateSync(real(text(path)), Number(length)); }); },
    ftruncate(fd, length) { guard(() => { nodeFs.ftruncateSync(fd, Number(length)); }); },
    link(from, to) { guard(() => { nodeFs.linkSync(real(text(from)), real(text(to))); }); },
    symlink(target, path) { calls.push(`symlink ${text(path)}`); guard(() => { nodeFs.symlinkSync(text(target), real(text(path))); }); },
    readlink: path => guard(() => nodeFs.readlinkSync(real(text(path)))),
    realpath: path => guard(() => nodeFs.realpathSync(real(text(path)))),
    readFile: (path, maxBytes) => {
      const bytes = guard(() => nodeFs.readFileSync(real(text(path))));
      if (maxBytes !== undefined && bytes.length > maxBytes) throw new LinuxError(27);
      return Uint8Array.from(bytes);
    },
    writeFile(path, bytes) { guard(() => { nodeFs.writeFileSync(real(text(path)), bytes); }); },
    fsync() { /* nothing to flush on the test machine */ },
    dup() { throw new LinuxError(38); },
    pipe() { throw new LinuxError(38); },
  };
  return { files, real, openDescriptors: () => positions.size, calls };
}

/** The real kit's errno helpers, so that tests map errors exactly as the runner's host does. */
export const errno = kit.errno;
