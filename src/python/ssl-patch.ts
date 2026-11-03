/**
 * TLS for Python's `ssl` on the engine's TLS client (engine ADR 0029, N-4 and N-7). Pyodide's `ssl` is a stub whose
 * sockets cannot encrypt; this makes its `SSLSocket` (for `wrap_socket`: urllib, http.client, smtplib, requests) and its
 * `SSLObject` (for `wrap_bio`, memory BIOs) run a TLS client session of the engine through `_oxidevm_bridge.tls_*`. The
 * ciphertext travels on the program's own socket, read and written with `_socket.socket`'s methods, so it takes the VM's
 * network and reach. As in CPython 3.14 with OpenSSL 3:
 * - a certificate the VM does not trust fails the handshake with `ssl.SSLCertVerificationError`, `reason`
 *   `CERTIFICATE_VERIFY_FAILED`, `library` `SSL`, and OpenSSL's `verify_code` and `verify_message` (20 "unable to get
 *   local issuer certificate", 62 "Hostname mismatch, certificate is not valid for '<name>'.", 10 "certificate has
 *   expired", 9 "certificate is not yet valid"), worded "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
 *   <message> (_ssl.c:1081)";
 * - a peer that closes without close_notify is `ssl.SSLEOFError`, which `suppress_ragged_eofs` turns into b"";
 * - `wrap_bio` objects raise `ssl.SSLWantReadError` until the peer's bytes arrive.
 * - after the handshake, `getpeercert()` is the server's certificate decoded as CPython decodes it (src/x509.ts), `{}`
 *   when the context's `verify_mode` is CERT_NONE, and its DER with `binary_form`; before it, ValueError "handshake not
 *   done yet"; `version()` is "TLSv1.3" or "TLSv1.2" and `cipher()` (OpenSSL's name, the version, the secret bits), both
 *   None before the handshake (engine TLS API 2: `peerCertificates`, `protocolVersion`, `cipherSuite`).
 * - `load_verify_locations` (so `create_default_context(cafile=...)`, urllib3's and requests' `verify=<file>`) adds the
 *   authorities of a PEM file, a directory of PEM files, or `cadata` to the VM's for that context's sessions (engine TLS
 *   API 2, `trust`; only the certificates /etc/ssl/cert.pem lacks, src/trust.ts), failing as CPython does for a file or
 *   data without a certificate.
 * What differs, on purpose (README.md, Known limits): TLS always verifies, against the VM's /etc/ssl/cert.pem and the
 * authorities the program loaded, whatever `verify_mode` or `check_hostname` ask; server-side TLS and client
 * certificates are refused with `ssl.SSLError`.
 */
export const SSL_PATCH_SOURCE = `import builtins as _builtins
import errno as _errno
import json as _json
import os as _os
import socket as _socket
import ssl as _ssl

import _oxidevm_bridge as _bridge
import _socket as _csocket
from pyodide.ffi import to_js as _to_js

_WHERE = "(_ssl.c:1081)"
_READ_BYTES = 16384
_VERIFY = {
    "unknown-issuer": (20, "unable to get local issuer certificate"),
    "invalid-roots": (20, "unable to get local issuer certificate"),
    "certificate-expired": (10, "certificate has expired"),
    "certificate-not-yet-valid": (9, "certificate is not yet valid"),
    # The engine rejects the certificate itself (a self-signed one, or an authority's used as a server's); OpenSSL's
    # finer reasons are not known here.
    "bad-certificate": (1, "unspecified certificate verification error"),
}
_ALWAYS_VERIFIES = "This VM's TLS always verifies certificates, against /etc/ssl/cert.pem and the authorities the program loads (load_verify_locations); it cannot be turned off."
_PEM_CERTIFICATE = b"-----BEGIN CERTIFICATE-----"


def _ssl_error(outcome, hostname):
    failure = None if outcome.failure is None else str(outcome.failure)
    if failure == "name-mismatch":
        code, message = 62, "Hostname mismatch, certificate is not valid for " + repr(hostname) + "."
    elif failure in _VERIFY:
        code, message = _VERIFY[failure]
    elif failure is not None or str(outcome.code).startswith("ERR_TLS") or str(outcome.code).startswith("CERT_"):
        return _ssl.SSLError(1, "[SSL: " + str(outcome.code) + "] " + str(outcome.message) + " " + _WHERE)
    else:
        # Pyodide numbers errors as Emscripten does, so the error is named by its code, not its Linux number.
        return OSError(getattr(_errno, str(outcome.code), _errno.EIO), str(outcome.message))
    error = _ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: " + message + " " + _WHERE)
    error.reason, error.library, error.verify_code, error.verify_message = "CERTIFICATE_VERIFY_FAILED", "SSL", code, message
    error.add_note(_ALWAYS_VERIFIES)
    return error


def _tuples(value):
    """CPython's getpeercert() shape: every list of the decoded certificate is a tuple."""
    if isinstance(value, dict):
        return {key: _tuples(item) for key, item in value.items()}
    if isinstance(value, list):
        return tuple(_tuples(item) for item in value)
    return value


def _eof():
    return _ssl.SSLEOFError(_ssl.SSL_ERROR_EOF, "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol " + _WHERE)


class _Session:
    """One TLS client session of the engine, with the plaintext received and not yet read."""

    def __init__(self, hostname, alpn, trust):
        self.hostname = hostname
        self.handle = self._value(_bridge.tls_open(hostname, _to_js(list(alpn)), _to_js(list(trust))))
        self.plain = bytearray()

    def _value(self, outcome):
        if not outcome.ok:
            raise _ssl_error(outcome, self.hostname)
        return outcome.value

    def receive(self, data):
        self._value(_bridge.tls_receive(self.handle, _to_js(bytes(data))))

    def take(self):
        return self._value(_bridge.tls_take(self.handle)).to_bytes()

    def send(self, data):
        self._value(_bridge.tls_send(self.handle, _to_js(bytes(data))))

    def drain(self):
        while True:
            chunk = self._value(_bridge.tls_plaintext(self.handle, 65536)).to_bytes()
            if not chunk:
                return
            self.plain += chunk

    def status(self):
        status = self._value(_bridge.tls_status(self.handle))
        return str(status.state), None if status.alpn is None else str(status.alpn)

    def close(self):
        self._value(_bridge.tls_close(self.handle))

    def free(self):
        _bridge.tls_free(self.handle)

    def take_bytes(self, count):
        chunk = bytes(self.plain[:count])
        del self.plain[:count]
        return chunk

    # As _ssl's object, which libraries reach as SSLSocket._sslobj (httpcore asks it for the ALPN protocol).
    def selected_alpn_protocol(self):
        return self.status()[1]

    def peer(self):
        return _json.loads(str(self._value(_bridge.tls_peer(self.handle))))

    def getpeercert(self, binary_form=False, verified=True):
        """CPython's getpeercert(): verified is False when the context's verify_mode is CERT_NONE."""
        if self.peer()["version"] is None:
            raise ValueError("handshake not done yet")
        der = self._value(_bridge.tls_peer_certificate(self.handle)).to_bytes()
        if not der:
            return None
        if binary_form:
            return der
        if not verified:
            return {}
        outcome = _bridge.decode_certificate(_to_js(der))
        if not outcome.ok:
            raise _ssl.SSLError(1, "[SSL] the server's certificate cannot be decoded: " + str(outcome.message) + " " + _WHERE)
        return _tuples(_json.loads(str(outcome.value)))

    def pending(self):
        self.drain()
        return _builtins.len(self.plain)

    def version(self):
        return self.peer()["version"]

    def cipher(self):
        cipher = self.peer()["cipher"]
        return None if cipher is None else tuple(cipher)

    def compression(self):
        return None


def _trust_of(context):
    return list(getattr(context, "_oxidevm_trust", []))


def _alpn_of(context):
    return list(getattr(context, "_oxidevm_alpn", []))


def _check_client(context, server_side):
    if server_side:
        raise _ssl.SSLError(1, "[SSL] server-side TLS is not available in this VM " + _WHERE)
    if getattr(context, "_certfile_data", None) is not None:
        raise _ssl.SSLError(1, "[SSL] client certificates are not available in this VM " + _WHERE)


# SSLSocket: the stub's object layout, with TLS over the socket's own descriptor.

def _raw_send(sock, data):
    _csocket.socket.sendall(sock, data)


def _raw_recv(sock):
    return _csocket.socket.recv(sock, _READ_BYTES)


def _flush(sock, session):
    out = session.take()
    if out:
        _raw_send(sock, out)


def _session_of(sock):
    session = getattr(sock, "_oxidevm_session", None)
    if session is None:
        if getattr(sock, "_oxidevm_unwrapped", False) or sock._closed:
            raise ValueError("Read on closed or unwrapped SSL socket.")
        sock.do_handshake()
        session = sock._oxidevm_session
    return session


@classmethod
def _create(cls, sock, server_side=False, do_handshake_on_connect=True, suppress_ragged_eofs=True, server_hostname=None, context=None, session=None):
    if server_side and server_hostname:
        raise ValueError("server_hostname can only be specified in server mode")
    if server_side and session is not None:
        raise ValueError("session can only be specified in client mode")
    if context.check_hostname and not server_hostname:
        raise ValueError("check_hostname requires server_hostname")
    ssl_sock = cls.__new__(cls)
    _csocket.socket.__init__(ssl_sock, sock.family, sock.type, sock.proto, sock.fileno())
    timeout = sock.gettimeout()
    sock.detach()
    ssl_sock.settimeout(timeout)
    ssl_sock._io_refs, ssl_sock._closed = 0, False
    ssl_sock._sslobj, ssl_sock._context, ssl_sock._session = None, context, session
    ssl_sock._server_hostname = None if server_hostname is None else context._encode_hostname(server_hostname)
    ssl_sock._server_side, ssl_sock._suppress_ragged_eofs = server_side, suppress_ragged_eofs
    ssl_sock._do_handshake_on_connect = do_handshake_on_connect
    ssl_sock._oxidevm_session = None
    try:
        _csocket.socket.getpeername(ssl_sock)
        ssl_sock._connected = True
    except OSError:
        ssl_sock._connected = False
    if ssl_sock._connected and do_handshake_on_connect:
        if timeout == 0.0:
            raise ValueError("do_handshake_on_connect should not be specified for non-blocking sockets")
        ssl_sock.do_handshake()
    return ssl_sock


def do_handshake(self, block=False):
    if getattr(self, "_oxidevm_session", None) is not None:
        return
    _check_client(self._context, self._server_side)
    if not self._server_hostname:
        raise ValueError("this VM's TLS needs server_hostname to verify the server")
    session = _Session(self._server_hostname, _alpn_of(self._context), _trust_of(self._context))
    try:
        while True:
            _flush(self, session)
            state, _alpn = session.status()
            if state == "established":
                break
            if state != "handshaking":
                raise _eof()
            data = _raw_recv(self)
            if not data:
                raise _eof()
            session.receive(data)
    except BaseException:
        session.free()
        raise
    self._oxidevm_session = session
    self._sslobj = session


def _read_some(sock, session, count):
    while not session.plain:
        session.drain()
        if session.plain:
            break
        state, _alpn = session.status()
        if state in ("peer-closed", "closed"):
            return b""
        data = _raw_recv(sock)
        if not data:
            raise _eof()
        session.receive(data)
        _flush(sock, session)
    return session.take_bytes(count)


def read(self, len=1024, buffer=None):
    count = len
    session = _session_of(self)
    try:
        data = _read_some(self, session, count if buffer is None else min(count or _builtins.len(buffer), _builtins.len(buffer)))
    except _ssl.SSLEOFError:
        if not self._suppress_ragged_eofs:
            raise
        data = b""
    if buffer is None:
        return data
    memoryview(buffer)[: _builtins.len(data)] = data
    return _builtins.len(data)


def write(self, data):
    session = _session_of(self)
    payload = bytes(data)
    session.send(payload)
    _flush(self, session)
    return _builtins.len(payload)


def _no_flags(self, flags, call):
    if flags != 0:
        raise ValueError("non-zero flags not allowed in calls to " + call + "() on " + str(self.__class__))


def recv(self, buflen=1024, flags=0):
    _no_flags(self, flags, "recv")
    return self.read(buflen)


def recv_into(self, buffer, nbytes=None, flags=0):
    _no_flags(self, flags, "recv_into")
    return self.read(nbytes or _builtins.len(buffer), buffer)


def send(self, data, flags=0):
    _no_flags(self, flags, "send")
    return self.write(data)


def sendall(self, data, flags=0):
    _no_flags(self, flags, "sendall")
    self.write(data)


def pending(self):
    session = getattr(self, "_oxidevm_session", None)
    if session is None:
        return 0
    session.drain()
    return _builtins.len(session.plain)


def selected_alpn_protocol(self):
    session = getattr(self, "_oxidevm_session", None)
    return None if session is None else session.status()[1]


def getpeercert(self, binary_form=False):
    session = getattr(self, "_oxidevm_session", None)
    if session is None:
        raise ValueError("handshake not done yet")
    return session.getpeercert(binary_form, self._context.verify_mode != _ssl.CERT_NONE)


def version(self):
    session = getattr(self, "_oxidevm_session", None)
    return None if session is None else session.version()


def cipher(self):
    session = getattr(self, "_oxidevm_session", None)
    return None if session is None else session.cipher()


def _release(self):
    session = getattr(self, "_oxidevm_session", None)
    self._oxidevm_session = None
    self._sslobj = None
    if session is not None:
        session.free()
    return session


def unwrap(self):
    session = getattr(self, "_oxidevm_session", None)
    if session is None:
        raise ValueError("No SSL wrapper around " + str(self))
    try:
        session.close()
        _flush(self, session)
    finally:
        _release(self)
        self._oxidevm_unwrapped = True
    return self


def shutdown(self, how):
    _release(self)
    _csocket.socket.shutdown(self, how)


def _real_close(self):
    _release(self)
    _socket.socket._real_close(self)


def connect(self, addr):
    if self._server_side:
        raise ValueError("can't connect in server-side mode")
    if self._connected or getattr(self, "_oxidevm_session", None) is not None:
        raise ValueError("attempt to connect already-connected SSLSocket!")
    _socket.socket.connect(self, addr)
    self._connected = True
    if self._do_handshake_on_connect:
        self.do_handshake()


def connect_ex(self, addr):
    try:
        self.connect(addr)
    except OSError as error:
        return error.errno
    return 0


for _name, _value in {
    "_create": _create, "do_handshake": do_handshake, "read": read, "write": write, "recv": recv, "recv_into": recv_into,
    "send": send, "sendall": sendall, "pending": pending, "selected_alpn_protocol": selected_alpn_protocol,
    "getpeercert": getpeercert, "version": version, "cipher": cipher, "unwrap": unwrap, "shutdown": shutdown, "_real_close": _real_close, "connect": connect,
    "connect_ex": connect_ex,
}.items():
    setattr(_ssl.SSLSocket, _name, _value)


# SSLObject: memory BIOs, for asyncio's SSL protocol and programs that move the bytes themselves.

def _want_read():
    return _ssl.SSLWantReadError(_ssl.SSL_ERROR_WANT_READ, "The operation did not complete (read) " + _WHERE)


def _bio_feed(self):
    data = self._incoming.read()
    if data:
        self._oxidevm_session.receive(data)
    out = self._oxidevm_session.take()
    if out:
        self._outgoing.write(out)


@classmethod
def _object_create(cls, incoming, outgoing, server_side=False, server_hostname=None, session=None, context=None):
    _check_client(context, server_side)
    if context.check_hostname and not server_hostname:
        raise ValueError("check_hostname requires server_hostname")
    if not server_hostname:
        raise ValueError("this VM's TLS needs server_hostname to verify the server")
    self = object.__new__(cls)
    hostname = context._encode_hostname(server_hostname)
    self.__dict__.update({"_incoming": incoming, "_outgoing": outgoing, "_context": context, "_hostname": hostname, "_session_object": session, "_established": False})
    self._oxidevm_session = _Session(hostname, _alpn_of(context), _trust_of(context))
    return self


def _object_do_handshake(self):
    if self._established:
        return
    _bio_feed(self)
    state, _alpn = self._oxidevm_session.status()
    if state == "established":
        self._established = True
        return
    if state != "handshaking" or self._incoming.eof:
        raise _eof()
    raise _want_read()


def _object_read(self, len=1024, buffer=None):
    session = self._oxidevm_session
    count = len if buffer is None else min(len or _builtins.len(buffer), _builtins.len(buffer))
    session.drain()
    if not session.plain:
        _bio_feed(self)
        session.drain()
    if not session.plain:
        state, _alpn = session.status()
        if state in ("peer-closed", "closed"):
            data = b""
        elif self._incoming.eof:
            raise _eof()
        else:
            raise _want_read()
    else:
        data = session.take_bytes(count)
    if buffer is None:
        return data
    memoryview(buffer)[: _builtins.len(data)] = data
    return _builtins.len(data)


def _object_write(self, data):
    payload = bytes(data)
    self._oxidevm_session.send(payload)
    _bio_feed(self)
    return _builtins.len(payload)


def _object_pending(self):
    self._oxidevm_session.drain()
    return _builtins.len(self._oxidevm_session.plain)


def _object_unwrap(self):
    self._oxidevm_session.close()
    _bio_feed(self)
    self._oxidevm_session.free()


for _name, _value in {
    "_create": _object_create, "do_handshake": _object_do_handshake, "read": _object_read, "write": _object_write,
    "pending": _object_pending, "unwrap": _object_unwrap,
    "selected_alpn_protocol": lambda self: self._oxidevm_session.status()[1],
    "getpeercert": lambda self, binary_form=False: self._oxidevm_session.getpeercert(binary_form, self._context.verify_mode != _ssl.CERT_NONE),
    "version": lambda self: self._oxidevm_session.version(),
    "cipher": lambda self: self._oxidevm_session.cipher(),
    "context": property(lambda self: self._context),
    "server_hostname": property(lambda self: self._hostname),
    "server_side": property(lambda self: False),
    "session": property(lambda self: self._session_object),
}.items():
    setattr(_ssl.SSLObject, _name, _value)


def wrap_bio(self, incoming, outgoing, server_side=False, server_hostname=None, session=None):
    return self.sslobject_class._create(incoming, outgoing, server_side=server_side, server_hostname=server_hostname, session=session, context=self)


def _read_authorities(path):
    try:
        with open(path, "rb") as file:
            return file.read()
    except OSError as error:
        # As CPython reports it: the errno and its text, without the file's name.
        raise type(error)(error.errno, error.strerror) from None


def load_verify_locations(self, cafile=None, capath=None, cadata=None):
    """Adds authorities to the VM's /etc/ssl/cert.pem for this context's sessions (engine TLS API 2, trust)."""
    if cafile is None and capath is None and cadata is None:
        raise TypeError("cafile, capath and cadata cannot be all omitted")
    entries = []
    if cadata is not None:
        if isinstance(cadata, str):
            try:
                data = cadata.encode("ascii")
            except UnicodeEncodeError:
                raise TypeError("cadata should be an ASCII string or a bytes-like object") from None
            if _PEM_CERTIFICATE not in data:
                raise _ssl.SSLError(0, "no start line: cadata does not contain a certificate (_ssl.c:4279)")
        else:
            try:
                data = bytes(memoryview(cadata))
            except TypeError:
                raise TypeError("cadata should be an ASCII string or a bytes-like object") from None
            if not data.startswith(b"\\x30"):
                raise _ssl.SSLError(0, "not enough data: cadata does not contain a certificate (_ssl.c:4279)")
        entries.append(data)
    if cafile is not None:
        data = _read_authorities(_os.fspath(cafile))
        if _PEM_CERTIFICATE not in data:
            error = _ssl.SSLError(136, "[X509: NO_CERTIFICATE_OR_CRL_FOUND] no certificate or crl found (_ssl.c:4413)")
            error.reason, error.library = "NO_CERTIFICATE_OR_CRL_FOUND", "X509"
            raise error
        entries.append(data)
    if capath is not None:
        # OpenSSL looks certificates up there by hash when it needs one; this reads them all, in name order.
        directory = _os.fspath(capath)
        names = sorted(_os.listdir(directory)) if _os.path.isdir(directory) else []
        for name in names:
            path = _os.path.join(directory, name)
            if _os.path.isfile(path):
                data = _read_authorities(path)
                if _PEM_CERTIFICATE in data:
                    entries.append(data)
    self._oxidevm_trust = _trust_of(self) + entries


def set_alpn_protocols(self, alpn_protocols):
    protocols = []
    for protocol in alpn_protocols:
        encoded = protocol.encode("ascii") if isinstance(protocol, str) else bytes(protocol)
        if not 1 <= _builtins.len(encoded) <= 255:
            raise _ssl.SSLError("ALPN protocols must be 1 to 255 in length")
        protocols.append(encoded.decode("ascii"))
    self._oxidevm_alpn = protocols


for _error in (_ssl.SSLError, _ssl.SSLZeroReturnError, _ssl.SSLWantReadError, _ssl.SSLWantWriteError, _ssl.SSLSyscallError, _ssl.SSLEOFError, _ssl.SSLCertVerificationError):
    _error.__module__ = "ssl"

_ssl.SSLContext.wrap_bio = wrap_bio
_ssl.SSLContext.set_alpn_protocols = set_alpn_protocols
_ssl.SSLContext.load_verify_locations = load_verify_locations
_ssl.HAS_TLSv1_3 = True
# The engine checks the server's name against the certificate's subject alternative names only, never its common name,
# so libraries (urllib3) leave the check to it instead of matching names themselves from getpeercert().
_ssl.HAS_NEVER_CHECK_COMMON_NAME = True
_ssl.OPENSSL_VERSION = "OpenSSL 3 compatible (OxideVM TLS client, rustls)"
`;
