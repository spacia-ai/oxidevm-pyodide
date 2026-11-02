/**
 * Names for Python's `socket` through the VM's resolver (engine ADR 0029, N-4). `kit.emscripten.network` connects
 * Pyodide's sockets to the VM and answers Emscripten's own lookups, but a name that does not resolve can only become the
 * unspecified address there. So `socket.getaddrinfo`, `gethostbyname` and `gethostbyname_ex` ask the resolver
 * themselves (`_oxidevm_bridge.resolve`, synchronous) and fail as CPython 3.14 does on Linux:
 * `socket.gaierror(-2, 'Name or service not known')` for a name that does not exist (EAI_NONAME, with glibc's text) and
 * `socket.gaierror(-3, 'Temporary failure in name resolution')` when the nameserver does not answer. While the VM is
 * not connected to the internet, a lookup fails with PermissionError (EPERM), as a connection does. Only IPv4 addresses
 * are returned: Pyodide's sockets and its getaddrinfo take IPv4 only. Numeric addresses
 * and `None` go to Pyodide's own functions unchanged, and the resolved addresses are turned into results by them too,
 * so the tuples are exactly what CPython returns for those addresses.
 */
export const SOCKET_PATCH_SOURCE = `import errno as _errno
import os as _os
import socket as _socket

import _oxidevm_bridge as _bridge

_original_getaddrinfo = _socket.getaddrinfo
_original_gethostbyname = _socket.gethostbyname
_original_gethostbyname_ex = _socket.gethostbyname_ex

# glibc's texts, which CPython on Linux prints; Emscripten's musl words them differently.
_NONAME = (-2, "Name or service not known")
_AGAIN = (-3, "Temporary failure in name resolution")
_FAIL = (-4, "Non-recoverable failure in name resolution")
_BY_CODE = {"ENOTFOUND": _NONAME, "ENODATA": _NONAME, "EAI_AGAIN": _AGAIN, "ETIMEDOUT": _AGAIN}


def _numeric(name):
    for family in (_socket.AF_INET, _socket.AF_INET6):
        try:
            _socket.inet_pton(family, name)
            return True
        except (OSError, ValueError):
            pass
    return False


def _text(host):
    if isinstance(host, (bytes, bytearray)):
        return bytes(host).decode("ascii")
    return host.encode("idna").decode("ascii")


def _resolve(name):
    outcome = _bridge.resolve(name)
    if outcome.ok:
        return [str(address) for address in outcome.value]
    if outcome.code in ("EPERM", "EACCES"):
        # Pyodide numbers errors as Emscripten does (errno.EPERM is not 1), so the error is named, not numbered.
        number = getattr(_errno, str(outcome.code))
        raise OSError(number, _os.strerror(number))
    raise _socket.gaierror(*_BY_CODE.get(str(outcome.code), _FAIL))


def _ipv4(addresses):
    """The IPv4 addresses: Pyodide's sockets and its getaddrinfo take IPv4 only."""
    return [address for address in addresses if ":" not in address]


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if not isinstance(host, (str, bytes, bytearray)) or not host:
        return _original_getaddrinfo(host, port, family, type, proto, flags)
    name = _text(host)
    if _numeric(name) or flags & _socket.AI_NUMERICHOST:
        return _original_getaddrinfo(host, port, family, type, proto, flags)
    wanted = _ipv4(_resolve(name)) if family in (0, _socket.AF_UNSPEC, _socket.AF_INET) else []
    if not wanted:
        raise _socket.gaierror(*_NONAME)
    results = []
    for address in wanted:
        for entry in _original_getaddrinfo(address, port, family, type, proto, flags | _socket.AI_NUMERICHOST):
            canonical = name if flags & _socket.AI_CANONNAME and not results else entry[3]
            results.append((entry[0], entry[1], entry[2], canonical, entry[4]))
    return results


def gethostbyname(hostname):
    name = _text(hostname)
    if _numeric(name):
        return _original_gethostbyname(hostname)
    addresses = _ipv4(_resolve(name))
    if not addresses:
        raise _socket.gaierror(*_NONAME)
    return addresses[0]


def gethostbyname_ex(hostname):
    name = _text(hostname)
    if _numeric(name):
        return _original_gethostbyname_ex(hostname)
    addresses = _ipv4(_resolve(name))
    if not addresses:
        raise _socket.gaierror(*_NONAME)
    return (name, [], addresses)


for _function in (getaddrinfo, gethostbyname, gethostbyname_ex):
    _function.__module__ = "socket"
    _function.__qualname__ = _function.__name__
    _function.__doc__ = getattr(_socket, _function.__name__).__doc__
    setattr(_socket, _function.__name__, _function)
`;
