/**
 * Makes the process identity that Python reports the real one. Emscripten answers `os.getpid()` and the user and group
 * ids with fixed numbers (the user is always root), but this program is a Linux process of the VM with its own pid
 * and credentials. `_oxidevm_process` is a JS module with those numbers and the working directory.
 */
export const PROCESS_PATCH_SOURCE = `import os
import _oxidevm_process as _process

os.getpid = lambda: int(_process.pid)
os.getuid = lambda: int(_process.uid)
os.geteuid = lambda: int(_process.uid)
os.getgid = lambda: int(_process.gid)
os.getegid = lambda: int(_process.gid)
os.chdir(_process.cwd)
`;
