"""Records how CPython itself reports the network failures that the module's socket and ssl replacements reproduce.

The module's Python networking (src/python/socket-patch.ts, src/python/ssl-module.ts) must fail the way CPython 3.14 does,
so that programs that catch socket.gaierror, ConnectionRefusedError or ssl.SSLCertVerificationError, or print them, see
what they would see natively. test/network.test.ts compares the module with what this script records:

    python3.14 -I scripts/record-cpython-net.py             writes test/fixtures/cpython-net.json
    python3.14 -I scripts/record-cpython-net.py --check     fails when the recording differs from that file

Everything happens on this machine: the name lookup asks for a name under .invalid (RFC 6761: never resolves), the
refused connection goes to a loopback port nobody listens on, and the TLS failures come from a TLS server on loopback
with certificates this script makes with the openssl command in a temporary directory: a self-signed one, one from a
private authority the client does not trust, one for another host name from an authority it trusts, and an expired one.

It also records what CPython shows of a server it is connected to: `getpeercert()` (the decoded certificate, and its DER
with `binary_form`), `version()` and `cipher()`, over TLS 1.3 and over TLS 1.2 with each ECDHE-ECDSA suite. The
certificates whose decoding is recorded (`certificates`: a rich leaf with every kind of subject alternative name, access
and distribution URIs, a UTF-8 and a multi-valued subject, a serial with its high bit set and a GeneralizedTime expiry,
and the authority that issued it) are kept in the fixture, so that recording again decodes the same certificates; pass
`--new-certificates` to make new ones.
"""

import argparse
import base64
import datetime
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "fixtures", "cpython-net.json")
UNRESOLVABLE = "nonexistent.invalid"


def openssl(*arguments, cwd):
    subprocess.run(["openssl", *arguments], cwd=cwd, check=True, capture_output=True, timeout=60)


def make_certificates(directory):
    """A private authority, and leaf certificates for localhost: trusted, self-signed, for another name, expired."""
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
            "-subj", "/CN=Recording Authority", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-days", "2", cwd=directory)
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "self.key", "-out", "self.pem",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2", cwd=directory)
    for name, san, validity in (("good", "DNS:localhost", ["-days", "2"]), ("other", "DNS:other.example", ["-days", "2"]),
                                ("expired", "DNS:localhost", ["-not_before", "20200101000000Z", "-not_after", "20200102000000Z"])):
        openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", f"{name}.key", "-out", f"{name}.csr",
                "-subj", "/CN=localhost", cwd=directory)
        with open(os.path.join(directory, f"{name}.ext"), "w", encoding="utf-8") as file:
            file.write(f"subjectAltName={san}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n")
        openssl("x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", f"{name}.pem",
                "-extfile", f"{name}.ext", *validity, cwd=directory)


RICH_EXTENSIONS = """subjectAltName=DNS:rich.example,DNS:*.rich.example,IP:192.0.2.7,IP:2001:db8::1,email:certs@rich.example,URI:https://rich.example/path,RID:1.2.3.4,otherName:1.2.3.5;UTF8:other,dirName:dir_sect
authorityInfoAccess=OCSP;URI:http://ocsp.rich.example/,caIssuers;URI:http://ca.rich.example/ca.der
crlDistributionPoints=URI:http://crl.rich.example/ca.crl
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth

[dir_sect]
C=NL
O=Directory Org
CN=Directory Name
"""


def make_decoded_certificates(directory):
    """The certificates whose decoding is recorded: an authority, and a leaf it issued with every field getpeercert shows."""
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "rich-ca.key", "-out", "rich-ca.pem",
            "-subj", "/C=NL/O=Recording Authority/CN=Recording Root", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-days", "3650", "-set_serial", "1", cwd=directory)
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "rich.key", "-out", "rich.csr", "-utf8",
            "-multivalue-rdn", "-subj", "/C=NL/ST=Noord-Holland/L=Amsterdam/O=Zażółć Gęślą/OU=Recording+OU=Second Unit/CN=rich.example/emailAddress=certs@rich.example",
            cwd=directory)
    with open(os.path.join(directory, "rich.ext"), "w", encoding="utf-8") as file:
        file.write(RICH_EXTENSIONS)
    openssl("x509", "-req", "-in", "rich.csr", "-CA", "rich-ca.pem", "-CAkey", "rich-ca.key", "-set_serial", "0x80F1E2D3C4B5A69788", "-out", "rich.pem",
            "-extfile", "rich.ext", "-not_before", "20260101093405Z", "-not_after", "20510615120000Z", cwd=directory)
    certificates = {}
    for name in ("rich", "rich-ca"):
        with open(os.path.join(directory, f"{name}.pem"), encoding="ascii") as file:
            certificates[name] = {"pem": file.read()}
    return certificates


def decode_certificates(certificates, directory):
    """CPython's own decoding of each certificate (the dict getpeercert() returns), with its DER in base64."""
    decoded = {}
    for name, entry in certificates.items():
        path = os.path.join(directory, f"decode-{name}.pem")
        with open(path, "w", encoding="ascii") as file:
            file.write(entry["pem"])
        decoded[name] = {"pem": entry["pem"], "der": base64.b64encode(ssl.PEM_cert_to_DER_cert(entry["pem"])).decode("ascii"),
                         "decoded": repr(ssl._ssl._test_decode_cert(path))}
    return decoded


class TlsServer:
    """A TLS server on loopback that completes handshakes (or fails them) and closes."""

    def __init__(self, directory, name, maximum=None, ciphers=None):
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(os.path.join(directory, f"{name}.pem"), os.path.join(directory, f"{name}.key"))
        if maximum is not None:
            self.context.maximum_version = maximum
        if ciphers is not None:
            self.context.set_ciphers(ciphers)
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            try:
                with self.context.wrap_socket(connection, server_side=True) as secured:
                    secured.recv(1024)
                    secured.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            except (ssl.SSLError, OSError):
                pass

    def close(self):
        self.listener.close()


def describe(error):
    """What a program can see of an exception: its type, args, text and the ssl attributes it has."""
    seen = {"type": f"{type(error).__module__}.{type(error).__qualname__}", "args": [repr(arg) for arg in error.args], "str": str(error),
            "errno": getattr(error, "errno", None)}
    for name in ("reason", "library", "verify_code", "verify_message"):
        value = getattr(error, name, None)
        if isinstance(value, (str, int)):
            seen[name] = value
    if isinstance(error, urllib.error.URLError):
        seen["urlReason"] = describe(error.reason) if isinstance(error.reason, BaseException) else repr(error.reason)
    return seen


def outcome(action):
    try:
        return {"result": repr(action())}
    except Exception as error:
        return {"error": describe(error)}


def refused_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def peer_information(directory, trusting):
    """What a client sees of the server after the handshake, over TLS 1.3 and over TLS 1.2 with each ECDHE-ECDSA suite."""
    seen = {}
    for label, maximum, ciphers in (("tls13", None, None), ("tls12-aes128", ssl.TLSVersion.TLSv1_2, "ECDHE-ECDSA-AES128-GCM-SHA256"),
                                    ("tls12-aes256", ssl.TLSVersion.TLSv1_2, "ECDHE-ECDSA-AES256-GCM-SHA384"),
                                    ("tls12-chacha20", ssl.TLSVersion.TLSv1_2, "ECDHE-ECDSA-CHACHA20-POLY1305")):
        server = TlsServer(directory, "good", maximum, ciphers)
        try:
            with socket.create_connection(("127.0.0.1", server.port), timeout=10) as raw:
                with trusting.wrap_socket(raw, server_hostname="localhost") as secured:
                    seen[label] = {"version": secured.version(), "cipher": list(secured.cipher())}
        finally:
            server.close()
    return seen


def silent_server():
    """A server on loopback that accepts connections and never sends a byte."""
    listener = socket.create_server(("127.0.0.1", 0))
    accepted = []

    def accept():
        while True:
            try:
                accepted.append(listener.accept()[0])
            except OSError:
                return
    threading.Thread(target=accept, daemon=True).start()
    return listener, accepted


def record(certificates):
    cases = {}
    cases["getaddrinfo-unresolvable"] = outcome(lambda: socket.getaddrinfo(UNRESOLVABLE, 80))
    cases["gethostbyname-unresolvable"] = outcome(lambda: socket.gethostbyname(UNRESOLVABLE))
    cases["create-connection-unresolvable"] = outcome(lambda: socket.create_connection((UNRESOLVABLE, 80), timeout=10))
    cases["urlopen-unresolvable"] = outcome(lambda: urllib.request.urlopen(f"http://{UNRESOLVABLE}/", timeout=10))
    cases["socket-connect-unresolvable"] = outcome(lambda: socket.socket().connect((UNRESOLVABLE, 80)))
    listener, accepted = silent_server()
    try:
        def receive_with_timeout():
            with socket.create_connection(listener.getsockname(), timeout=10) as connection:
                connection.settimeout(0.2)
                return connection.recv(10)
        cases["recv-timeout"] = outcome(receive_with_timeout)
        cases["create-connection-recv-timeout"] = outcome(lambda: socket.create_connection(listener.getsockname(), timeout=0.2).recv(10))
        def nonblocking_recv():
            with socket.create_connection(listener.getsockname(), timeout=10) as connection:
                connection.setblocking(False)
                return connection.recv(10)
        cases["recv-nonblocking"] = outcome(nonblocking_recv)
    finally:
        listener.close()
        for connection in accepted:
            connection.close()
    with tempfile.TemporaryDirectory() as scratch:
        empty = os.path.join(scratch, "empty.pem")
        open(empty, "w", encoding="ascii").close()

        def load(**locations):
            return ssl.create_default_context().load_verify_locations(**locations)
        cases["cafile-empty"] = outcome(lambda: load(cafile=empty))
        cases["cafile-missing"] = outcome(lambda: load(cafile=os.path.join(scratch, "missing.pem")))
        cases["cadata-text-without-certificate"] = outcome(lambda: load(cadata="hello"))
        cases["cadata-bytes-without-certificate"] = outcome(lambda: load(cadata=b"hello"))
        cases["load-verify-locations-nothing"] = outcome(lambda: load())
        cases["cadata-wrong-type"] = outcome(lambda: load(cadata=5))
    port = refused_port()
    cases["create-connection-refused"] = outcome(lambda: socket.create_connection(("127.0.0.1", port), timeout=10))
    cases["urlopen-refused"] = outcome(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10))
    with tempfile.TemporaryDirectory() as directory:
        make_certificates(directory)
        trusting = ssl.create_default_context(cafile=os.path.join(directory, "ca.pem"))
        for name in ("self", "good", "other", "expired"):
            server = TlsServer(directory, name)
            try:
                for label, context in (("default", ssl.create_default_context()), ("trusting", trusting)):
                    def handshake(context=context, port=server.port):
                        with socket.create_connection(("127.0.0.1", port), timeout=10) as raw:
                            with context.wrap_socket(raw, server_hostname="localhost") as secured:
                                return secured.version() is not None
                    cases[f"tls-{name}-{label}"] = outcome(handshake)
                cases[f"urlopen-tls-{name}-trusting"] = outcome(lambda port=server.port: urllib.request.urlopen(f"https://localhost:{port}/", context=trusting, timeout=10).status)
            finally:
                server.close()
        peer = peer_information(directory, trusting)
        made = certificates if certificates is not None else make_decoded_certificates(directory)
        decoded = decode_certificates(made, directory)
    return {
        "schemaVersion": 1,
        "provenance": {
            "interpreter": os.path.realpath(sys.executable),
            "version": sys.version.split()[0],
            "openssl": ssl.OPENSSL_VERSION,
            "recorded": datetime.date.today().isoformat(),
            "recorder": "scripts/record-cpython-net.py",
            "command": "python3.14 -I scripts/record-cpython-net.py",
            "unresolvable": UNRESOLVABLE,
        },
        "cases": cases,
        "peer": peer,
        "certificates": decoded,
    }


def main():
    parser = argparse.ArgumentParser(description="Record CPython's network failures for the module's tests.")
    parser.add_argument("--check", action="store_true", help="compare with the fixture instead of writing it (the date is not compared)")
    parser.add_argument("--new-certificates", action="store_true", help="make new certificates to decode instead of those in the fixture")
    options = parser.parse_args()
    if not sys.version.startswith("3.14."):
        sys.exit(f"this is Python {sys.version.split()[0]}; the module follows CPython 3.14")
    kept = None
    if not options.new_certificates and os.path.exists(FIXTURE):
        with open(FIXTURE, encoding="utf-8") as file:
            kept = {name: {"pem": entry["pem"]} for name, entry in json.load(file).get("certificates", {}).items()} or None
    recorded = record(kept)
    if options.check:
        with open(FIXTURE, encoding="utf-8") as file:
            existing = json.load(file)
        existing["provenance"]["recorded"] = recorded["provenance"]["recorded"]
        if existing != recorded:
            sys.exit(f"{FIXTURE} differs from what this CPython does now; record it again")
        print(f"{FIXTURE} matches")
        return
    with open(FIXTURE, "w", encoding="utf-8") as file:
        json.dump(recorded, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"wrote {len(recorded['cases'])} cases to {FIXTURE}")


if __name__ == "__main__":
    main()
