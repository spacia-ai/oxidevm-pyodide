/**
 * The source of the Python module `oxidevm`, which programs run by this module import to reach the Linux system around
 * them. It is written into Pyodide's file system and imported like any other module, so tracebacks show its lines.
 * It talks to the JS functions of `src/native-bridge.ts` and `src/socket-bridge.ts`, registered as `_oxidevm_bridge`.
 */
export const OXIDEVM_MODULE_SOURCE = `"""Reach the Linux system that this Python program runs next to.

The program runs as a WebAssembly Python (Pyodide) module inside an OxideVM page. It shares the VM's files, process ids
and sockets with the native Linux programs of the same VM, and this module is how it starts those programs and talks to
the services they listen with.

    import oxidevm

    result = oxidevm.run(["/bin/uname", "-m"])
    print(result.stdout)

    with oxidevm.connect_unix("/workspace/_oxidevm/service.sock") as connection:
        connection.sendall(b"ping\\\\n")
        print(connection.recv(100))
"""

import errno as _errno
import json as _json
import os as _os
import types as _types

import _oxidevm_bridge as _bridge
from pyodide.ffi import JsException, run_sync, to_js

__all__ = ["Connection", "connect_tcp", "connect_unix", "run"]

_MAX_RECV = 1024 * 1024


def run(argv, *, input="", check=True, timeout=10):
    """Run a native Linux program, wait for it, and return what it did.

    argv is the program's absolute path followed by its arguments (at most 64, without NUL characters). input is text
    for its standard input (at most 5 MiB), and timeout is in seconds (from 0.001 to 180): the program is killed when it
    runs out. Standard output and standard error are returned as text, at most 1 MiB each.

    The result has pid, returncode (minus the signal number when a signal ended the program), stdout and stderr. When
    check is true, a program that does not exit with status 0 raises RuntimeError with the start of its standard error.
    """
    reply = _json.loads(run_sync(_bridge.run(_json.dumps(argv), input, round(timeout * 1000))))
    result = _types.SimpleNamespace(**reply)
    if check and result.returncode != 0:
        raise RuntimeError("Native command exited " + str(result.returncode) + ": " + result.stderr[:4096])
    return result


def _os_error(error):
    """The OSError (of the matching subclass) for a failed socket operation."""
    code = getattr(error, "code", None)
    number = getattr(_errno, code, None) if isinstance(code, str) else None
    return OSError(_errno.EIO if number is None else number, str(getattr(error, "message", error)))


def _call(promise):
    try:
        return run_sync(promise)
    except JsException as error:
        raise _os_error(error) from None


def _milliseconds(seconds, name):
    """A timeout in seconds as whole milliseconds; None means no timeout (0)."""
    if seconds is None:
        return 0
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not seconds > 0:
        raise ValueError(name + " must be None or a positive number of seconds")
    return max(1, round(seconds * 1000))


class Connection:
    """A blocking client socket to a service in the VM.

    It offers sendall, recv, settimeout and close, and works as a context manager. recv may return fewer bytes than
    asked for, like any socket's, and returns b"" when the other side has closed the connection.
    """

    __slots__ = ("_handle", "_timeout")

    def __init__(self, handle):
        self._handle = handle
        self._timeout = None

    def _open(self):
        if self._handle is None:
            raise OSError(_errno.EBADF, "Bad file descriptor")
        return self._handle

    def settimeout(self, timeout):
        """Limit sendall and recv to timeout seconds (None waits for as long as it takes). They raise TimeoutError."""
        _milliseconds(timeout, "timeout")
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def sendall(self, data):
        """Send all of data (bytes or any bytes-like object)."""
        handle = self._open()
        payload = bytes(data)
        _call(_bridge.send(handle, to_js(payload), _milliseconds(self._timeout, "timeout")))

    def recv(self, bufsize):
        """Wait for data and return up to bufsize bytes (at most 1 MiB); b"" means the other side closed."""
        handle = self._open()
        if isinstance(bufsize, bool) or not isinstance(bufsize, int) or bufsize < 1:
            raise ValueError("bufsize must be a positive integer")
        return _call(_bridge.recv(handle, min(bufsize, _MAX_RECV), _milliseconds(self._timeout, "timeout"))).to_bytes()

    def close(self):
        """Close the connection. Closing twice is harmless."""
        handle, self._handle = self._handle, None
        if handle is not None:
            _call(_bridge.close(handle))

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        self.close()


def connect_unix(path, *, timeout=30.0):
    """Connect to the Unix socket at an absolute path (for example under /workspace/_oxidevm/).

    timeout limits only the connection attempt; use settimeout for later reads and writes.
    """
    path = _os.fspath(path)
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("path must be an absolute path")
    return Connection(_call(_bridge.connect("unix", path, 0, _milliseconds(timeout, "timeout"))))


def connect_tcp(port, host="127.0.0.1", *, timeout=30.0):
    """Connect to a TCP port on an IP address in the VM (127.0.0.1 unless a host is given).

    timeout limits only the connection attempt; use settimeout for later reads and writes.
    """
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("port must be an integer from 1 to 65535")
    if not isinstance(host, str) or not host:
        raise ValueError("host must be an IP address")
    return Connection(_call(_bridge.connect("tcp", host, port, _milliseconds(timeout, "timeout"))))
`;
