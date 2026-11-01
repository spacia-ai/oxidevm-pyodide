import type { PyodideInterface } from "pyodide";
import type { FileDescriptor, KitErrno, SyncFiles } from "./host-types.ts";

type LinuxTimestamp = Parameters<SyncFiles["utimes"]>[1];

/** Emscripten's file system object, which Pyodide exposes as `pyodide.FS`. */
export type EmscriptenFS = PyodideInterface["FS"];

/** The VM's workspace. Every tree appears in Python at the path it has in the VM, so no path is ever translated. */
export const WORKSPACE = "/workspace";
/** The VM's /tmp, which hides Pyodide's own (empty) one. */
export const TMP = "/tmp";

/**
 * Pyodide's own directories: its root, its standard library and site-packages, its devices, /proc and its home. A home
 * directory at one of them, inside one, or around one is not mounted, because it would hide files Pyodide needs.
 */
export const PYODIDE_DIRECTORIES = ["/", "/lib", "/dev", "/proc", "/home/pyodide"] as const;

/** The most bytes one read or write moves, so that a request for a huge buffer cannot ask the host for the same. */
export const MAX_TRANSFER_BYTES = 16 * 1024 ** 2;

// Linux errno values, which `errno.toEmscripten` turns into the numbers Emscripten uses.
const EIO = 5, EBADF = 9, EINVAL = 22, EOVERFLOW = 75, ENOTSUP = 95;
// Linux open flags.
const O_CREAT = 0o100, O_EXCL = 0o200;
const PERMISSION_BITS = 0o7777;
/** Emscripten asks `mknod` for a new file with every permission bit set, then applies the real mode with `chmod`. */
const MKNOD_ANY_MODE = 0o777;
const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;

/** An absolute path with `.`, `..`, empty components and a trailing slash resolved by name, as the kernel walks it. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Whether a normalised path is the tree itself or below it. */
export function within(path: string, tree: string): boolean {
  return tree === "/" ? path.startsWith("/") : path === tree || path.startsWith(`${tree}/`);
}

/** Whether a directory of the VM is there and is a directory (following symbolic links, as Linux opens it). */
function isDirectory(files: Pick<SyncFiles, "stat">, path: string): boolean {
  try {
    return (files.stat(path).mode & 0o170000) === 0o040000;
  } catch {
    return false;
  }
}

/**
 * The VM directories Python sees, each at its own path: the workspace, /tmp, and the home directory when it is an existing
 * directory that is neither at, inside nor around one of Pyodide's own directories nor already inside the other two.
 * A tree the VM does not have is left out.
 */
export function visibleTrees(home: string | undefined, files: Pick<SyncFiles, "stat">): readonly string[] {
  const trees = [WORKSPACE, TMP].filter(tree => isDirectory(files, tree));
  if (home === undefined || !home.startsWith("/")) return trees;
  const directory = normalizePath(home);
  const hidesPyodide = PYODIDE_DIRECTORIES.some(own => within(own, directory) || (own !== "/" && within(directory, own)));
  const shown = [WORKSPACE, TMP].some(tree => within(directory, tree));
  return hidesPyodide || shown || !isDirectory(files, directory) ? trees : [...trees, directory];
}

/**
 * Mounts a directory of the VM at the same path in Pyodide's file system. Every operation goes to the VM's own file API,
 * so Linux keeps ownership of permissions, atomic renames and locking, and a file that Python writes is at once the file
 * Linux reads. A rename from one mounted tree to another fails with EXDEV, as between two file systems.
 * A failed host call becomes the matching `OSError` (the host reports a Linux errno and Emscripten numbers errors
 * differently, so `errno` translates). Anything else that a host call throws is handed to `report` and becomes `EIO`:
 * an exception that is not an errno would unwind through the interpreter's frames, and Pyodide treats that as fatal.
 */
export function mountTree(fs: EmscriptenFS, files: SyncFiles, errno: KitErrno, tree: string, report: (error: unknown) => void = () => undefined): void {
  /** A file Emscripten has created but not yet opened: the stream that will own it once `chmod` supplies its real mode. */
  const creating = new WeakMap<FS.FSNode, FS.FSStream | null>();
  const descriptors = new Map<FS.FSStream, FileDescriptor>();

  const failure = (linuxErrno: number): FS.ErrnoError => new fs.ErrnoError(errno.toEmscripten(linuxErrno));

  function call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error: unknown) {
      if (error instanceof fs.ErrnoError) throw error;
      const linuxErrno = errno.of(error);
      if (linuxErrno !== undefined) throw failure(linuxErrno);
      report(error);
      throw failure(EIO);
    }
  }
  function failWith(linuxErrno: number): never {
    throw failure(linuxErrno);
  }
  function integerOf(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
  }
  /** A time for the host: milliseconds (or a `Date`) as an instant, `null` or nothing as "leave it unchanged"; anything else is refused. */
  function timestampOf(value: unknown): LinuxTimestamp {
    if (value === null || value === undefined) return "omit";
    const instant = value instanceof Date ? new Date(value.getTime()) : typeof value === "number" ? new Date(value) : undefined;
    if (instant === undefined || Number.isNaN(instant.getTime())) throw failure(EINVAL);
    return instant;
  }
  /** A file offset as the host takes it. Emscripten passes integers; anything else is refused instead of thrown at. */
  function offsetOf(value: number): bigint {
    if (!Number.isSafeInteger(value)) return failWith(EINVAL);
    return BigInt(value);
  }
  const path = (node: FS.FSNode): string => fs.getPath(node);
  const child = (node: FS.FSNode, name: string): string => `${path(node)}/${name}`;
  function descriptorOf(stream: FS.FSStream): FileDescriptor {
    const descriptor = descriptors.get(stream);
    if (descriptor === undefined) throw failure(EBADF);
    return descriptor;
  }
  /**
   * A node for whatever the host has at a path. Sockets, pipes and devices are nodes too: a directory that holds one (a
   * service's socket beside the programs that use it) must still list, import from and describe. Opening one is the host's
   * to refuse, and creating one is refused in `mknod`.
   */
  function make(parent: FS.FSNode | null, name: string, mode: number): FS.FSNode {
    return Object.assign(fs.createNode(parent, name, mode), { node_ops: nodes, stream_ops: streams });
  }

  /** Completes the creation of a file: opens it for real with the mode Emscripten has now supplied, and gives it its descriptor. */
  function finishCreating(node: FS.FSNode, mode: number): void {
    const stream = creating.get(node);
    if (stream === undefined || stream === null) throw failure(ENOTSUP);
    // `O_EXCL` makes a file that appeared in the meantime an error instead of a silent reuse; Linux applies its umask.
    const descriptor = files.open(path(node), stream.flags | O_CREAT | O_EXCL, mode & PERMISSION_BITS);
    descriptors.set(stream, descriptor);
    creating.delete(node);
    node.mode = files.fstat(descriptor).mode;
  }

  const nodes: FS.NodeOps = {
    getattr: node => call(() => {
      const stat = files.lstat(path(node)), size = Number(stat.size);
      if (!Number.isSafeInteger(size)) throw failure(EOVERFLOW);
      return {
        dev: Number(stat.device), ino: Number(stat.inode), mode: stat.mode, nlink: Number(stat.links), uid: stat.uid, gid: stat.gid, rdev: 0,
        size, blksize: 4096, blocks: Math.ceil(size / 512),
        atime: new Date(Number(stat.accessedNs / 1_000_000n)), mtime: new Date(Number(stat.modifiedNs / 1_000_000n)), ctime: new Date(Number(stat.changedNs / 1_000_000n)),
      };
    }),
    // Emscripten hands over plain numbers (times are milliseconds, or null to leave one unchanged), so every field is decoded.
    setattr(node, attributes: Readonly<Partial<Record<keyof FS.Stats, unknown>>>) {
      call(() => {
        const { mode, size, atime, mtime } = attributes;
        if (mode !== undefined) {
          const bits = integerOf(mode);
          if (bits === undefined) throw failure(EINVAL);
          if (creating.has(node)) finishCreating(node, bits);
          else files.chmod(path(node), bits & PERMISSION_BITS);
        }
        if (size !== undefined) {
          const length = integerOf(size);
          if (length === undefined || length < 0) throw failure(EINVAL);
          files.truncate(path(node), length);
        }
        // Last, because truncating changes the modification time and an explicit time must be the one that remains. Emscripten
        // resolved symbolic links before it got here, so the node is the file itself.
        if (atime !== undefined || mtime !== undefined) files.utimes(path(node), timestampOf(atime), timestampOf(mtime), { followLinks: true });
      });
    },
    lookup: (parent, name) => call(() => make(parent, name, files.lstat(child(parent, name)).mode)),
    mknod: (parent, name, mode) => call(() => {
      const target = child(parent, name);
      if (fs.isDir(mode)) {
        files.mkdir(target, mode & PERMISSION_BITS);
        return make(parent, name, mode);
      }
      if (!fs.isFile(mode) || (mode & MKNOD_ANY_MODE) !== MKNOD_ANY_MODE) throw failure(ENOTSUP);
      const node = make(parent, name, mode);
      creating.set(node, null);
      return node;
    }),
    rename(node, directory, name) {
      call(() => {
        files.rename(path(node), child(directory, name));
        node.parent = directory;
        node.name = name;
      });
    },
    unlink(parent, name) { call(() => { files.unlink(child(parent, name)); }); },
    rmdir(parent, name) { call(() => { files.unlink(child(parent, name), true); }); },
    readdir: node => call(() => [".", "..", ...files.readdir(path(node)).map(entry => entry.name).filter(name => name !== "." && name !== "..")]),
    symlink(parent, name, target) { call(() => { files.symlink(target, child(parent, name)); }); },
    readlink: node => call(() => files.readlink(path(node))),
  };

  const streams: FS.StreamOps = {
    open(stream) {
      call(() => {
        if (creating.has(stream.object)) creating.set(stream.object, stream);
        else descriptors.set(stream, files.open(path(stream.object), stream.flags));
      });
    },
    close(stream) {
      call(() => {
        const descriptor = descriptorOf(stream);
        descriptors.delete(stream);
        files.close(descriptor);
      });
    },
    read: (stream, buffer, offset, length, position) => call(() => {
      const descriptor = descriptorOf(stream);
      files.seek(descriptor, offsetOf(position), "start");
      const count = Math.min(length, MAX_TRANSFER_BYTES);
      // A host that answered with more than was asked for must not write past the region Emscripten lent us.
      const bytes = files.read(descriptor, count).subarray(0, count);
      buffer.set(bytes, offset);
      return bytes.length;
    }),
    write: (stream, buffer, offset, length, position) => call(() => {
      const descriptor = descriptorOf(stream);
      files.seek(descriptor, offsetOf(position), "start");
      return files.write(descriptor, buffer.subarray(offset, offset + Math.min(length, MAX_TRANSFER_BYTES)));
    }),
    llseek: (stream, offset, whence) => call(() => {
      const descriptor = descriptorOf(stream);
      // The position of the stream is Emscripten's: Linux's own offset moves when a read or write names its position.
      const reached = whence === SEEK_END ? files.seek(descriptor, offsetOf(offset), "end")
        : whence === SEEK_SET || whence === SEEK_CUR ? files.seek(descriptor, offsetOf((whence === SEEK_CUR ? stream.position : 0) + offset), "start")
        : failWith(EINVAL);
      const position = Number(reached);
      if (!Number.isSafeInteger(position)) throw failure(EOVERFLOW);
      return position;
    }),
  };

  fs.mkdirTree(tree);
  fs.mount({ mount: () => make(null, "/", files.stat(tree).mode), syncfs: (_mount, _populate, done) => { done(null); } }, {}, tree);
}
