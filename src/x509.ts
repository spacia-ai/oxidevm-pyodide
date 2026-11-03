/**
 * The certificate of a TLS server as CPython 3.14's `getpeercert()` shows it (Modules/_ssl.c, `_decode_certificate`):
 * `subject`, `issuer`, `version`, `serialNumber`, `notBefore`, `notAfter`, and, when the certificate has them,
 * `subjectAltName`, `OCSP`, `caIssuers` and `crlDistributionPoints`. The engine hands the server's chain over in DER
 * (`NetTlsSession.peerCertificates`); this decodes the fields CPython shows, with OpenSSL's attribute names and texts, as
 * JSON in which every array is one of CPython's tuples (src/python/ssl-patch.ts turns them into tuples). The expected
 * output is CPython's own (`certificates` in test/fixtures/cpython-net.json).
 */

/** One DER element: its tag byte and the bounds of its contents in `bytes`. */
interface Element {
  readonly tag: number;
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
}

export class CertificateError extends Error {
  constructor(message: string) { super(message); this.name = "CertificateError"; }
}

const SEQUENCE = 0x30, SET = 0x31, OID = 0x06, INTEGER = 0x02, BOOLEAN = 0x01, OCTETS = 0x04, UTC_TIME = 0x17, GENERALIZED_TIME = 0x18;

function element(bytes: Uint8Array, at: number, limit: number): Element {
  if (at + 2 > limit) throw new CertificateError("the certificate ends inside an element");
  const tag = bytes[at] ?? 0;
  if ((tag & 0x1f) === 0x1f) throw new CertificateError("the certificate uses a tag number above 30");
  let length = bytes[at + 1] ?? 0, start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) throw new CertificateError("the certificate has an invalid length");
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + (bytes[start + index] ?? 0);
    start += count;
  }
  if (start + length > limit) throw new CertificateError("an element runs past the end of the certificate");
  return { tag, bytes, start, end: start + length };
}

function children(parent: Element): Element[] {
  const found: Element[] = [];
  for (let at = parent.start; at < parent.end;) {
    const child = element(parent.bytes, at, parent.end);
    found.push(child);
    at = child.end;
  }
  return found;
}

function expect(value: Element | undefined, tag: number, what: string): Element {
  if (value?.tag !== tag) throw new CertificateError(`the certificate has no ${what}`);
  return value;
}

function contents(value: Element): Uint8Array {
  return value.bytes.subarray(value.start, value.end);
}

/** An object identifier in dotted form. */
function dotted(value: Element): string {
  const raw = contents(value), parts: number[] = [];
  let current = 0;
  for (const byte of raw) {
    current = current * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) { parts.push(current); current = 0; }
  }
  const [first = 0, ...rest] = parts;
  const top = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [top, first - top * 40, ...rest].join(".");
}

/** OpenSSL's long names of the attributes a distinguished name carries (`OBJ_obj2txt` with names). */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  "2.5.4.3": "commonName", "2.5.4.4": "surname", "2.5.4.5": "serialNumber", "2.5.4.6": "countryName", "2.5.4.7": "localityName",
  "2.5.4.8": "stateOrProvinceName", "2.5.4.9": "streetAddress", "2.5.4.10": "organizationName", "2.5.4.11": "organizationalUnitName",
  "2.5.4.12": "title", "2.5.4.13": "description", "2.5.4.15": "businessCategory", "2.5.4.17": "postalCode", "2.5.4.42": "givenName",
  "2.5.4.43": "initials", "2.5.4.44": "generationQualifier", "2.5.4.46": "dnQualifier", "2.5.4.65": "pseudonym",
  "2.5.4.97": "organizationIdentifier", "1.2.840.113549.1.9.1": "emailAddress", "0.9.2342.19200300.100.1.25": "domainComponent",
  "0.9.2342.19200300.100.1.1": "userId", "1.3.6.1.4.1.311.60.2.1.1": "jurisdictionLocalityName",
  "1.3.6.1.4.1.311.60.2.1.2": "jurisdictionStateOrProvinceName", "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionCountryName",
};

/** A directory string as UTF-8 text, as OpenSSL's `ASN1_STRING_to_UTF8` converts it. */
function text(value: Element): string {
  const raw = contents(value);
  switch (value.tag) {
    case 0x1e: return new TextDecoder("utf-16be").decode(raw);
    case 0x1c: {
      let out = "";
      for (let at = 0; at + 4 <= raw.length; at += 4) out += String.fromCodePoint(((raw[at] ?? 0) << 24 | (raw[at + 1] ?? 0) << 16 | (raw[at + 2] ?? 0) << 8 | (raw[at + 3] ?? 0)) >>> 0);
      return out;
    }
    // TeletexString: OpenSSL reads it as Latin-1.
    case 0x14: return String.fromCharCode(...raw);
    default: return new TextDecoder("utf-8").decode(raw);
  }
}

type NameTuple = (readonly [string, string])[][];

/** A distinguished name as CPython's tuple of relative names, each a tuple of (attribute, value) pairs. */
function name(value: Element): NameTuple {
  return children(expect(value, SEQUENCE, "name")).map(relative => children(expect(relative, SET, "relative name")).map(pair => {
    const [type, attribute] = children(expect(pair, SEQUENCE, "attribute"));
    const oid = dotted(expect(type, OID, "attribute type"));
    if (attribute === undefined) throw new CertificateError("an attribute has no value");
    return [ATTRIBUTE_NAMES[oid] ?? oid, text(attribute)] as const;
  }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A validity time as OpenSSL's `ASN1_TIME_print` writes it: "Jan  1 09:34:05 2026 GMT". */
function time(value: Element): string {
  const raw = new TextDecoder().decode(contents(value));
  const match = value.tag === UTC_TIME ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(raw)
    : value.tag === GENERALIZED_TIME ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(raw) : null;
  if (match === null) throw new CertificateError(`the certificate has a validity time OpenSSL would not print: ${raw}`);
  const [, y = "", mo = "", d = "", h = "", mi = "", s = ""] = match;
  const year = value.tag === UTC_TIME ? (Number(y) < 50 ? 2000 : 1900) + Number(y) : Number(y);
  const month = MONTHS[Number(mo) - 1];
  if (month === undefined) throw new CertificateError(`the certificate has a validity time in month ${mo}`);
  return `${month} ${String(Number(d)).padStart(2, " ")} ${h}:${mi}:${s} ${String(year)} GMT`;
}

/** A serial number as OpenSSL's `i2a_ASN1_INTEGER` writes it: upper-case hexadecimal bytes, without the sign byte. */
function serial(value: Element): string {
  const raw = contents(value);
  if ((raw[0] ?? 0) & 0x80) throw new CertificateError("the certificate has a negative serial number");
  const magnitude = raw.length > 1 && raw[0] === 0 ? raw.subarray(1) : raw;
  return Array.from(magnitude, byte => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function ipAddress(raw: Uint8Array): string {
  if (raw.length === 4) return Array.from(raw).join(".");
  if (raw.length !== 16) return "<invalid>";
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2) groups.push((((raw[at] ?? 0) << 8) | (raw[at + 1] ?? 0)).toString(16).toUpperCase());
  return groups.join(":");
}

type GeneralName = readonly [string, string | NameTuple];

/** One subject alternative name as CPython shows it (`_get_peer_alt_names`). */
function generalName(value: Element): GeneralName {
  switch (value.tag) {
    case 0xa0: return ["othername", "<unsupported>"];
    case 0x81: return ["email", text(value)];
    case 0x82: return ["DNS", text(value)];
    case 0xa3: return ["X400Name", "<unsupported>"];
    case 0xa4: {
      const [inner] = children(value);
      if (inner === undefined) throw new CertificateError("a directory name is empty");
      return ["DirName", name(inner)];
    }
    case 0xa5: return ["EdiPartyName", "<unsupported>"];
    case 0x86: return ["URI", text(value)];
    case 0x87: return ["IP Address", ipAddress(contents(value))];
    case 0x88: return ["Registered ID", dotted(value)];
    default: throw new CertificateError(`a subject alternative name has the unknown tag ${String(value.tag)}`);
  }
}

const URI = 0x86, OCSP = "1.3.6.1.5.5.7.48.1", CA_ISSUERS = "1.3.6.1.5.5.7.48.2";

/** The URIs of the authority information access of `method`. */
function accessUris(extension: Element, method: string): string[] {
  return children(expect(extension, SEQUENCE, "access description list")).flatMap(description => {
    const [kind, location] = children(expect(description, SEQUENCE, "access description"));
    return dotted(expect(kind, OID, "access method")) === method && location?.tag === URI ? [text(location)] : [];
  });
}

/** The full-name URIs of the CRL distribution points. */
function distributionUris(extension: Element): string[] {
  return children(expect(extension, SEQUENCE, "distribution points")).flatMap(point => {
    const where = children(expect(point, SEQUENCE, "distribution point")).find(part => part.tag === 0xa0);
    const full = where === undefined ? undefined : children(where).find(part => part.tag === 0xa0);
    return full === undefined ? [] : children(full).filter(part => part.tag === URI).map(text);
  });
}

/** The fields of a certificate that CPython's getpeercert() shows, in its order; arrays are CPython's tuples. */
export interface DecodedCertificate {
  readonly subject: NameTuple;
  readonly issuer: NameTuple;
  readonly version: number;
  readonly serialNumber: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly subjectAltName?: GeneralName[];
  readonly OCSP?: string[];
  readonly caIssuers?: string[];
  readonly crlDistributionPoints?: string[];
}

/** Decodes a DER certificate into what CPython's getpeercert() returns for it; malformed DER throws CertificateError. */
export function decodeCertificate(der: Uint8Array): DecodedCertificate {
  const certificate = element(der, 0, der.length);
  const [tbs] = children(expect(certificate, SEQUENCE, "certificate"));
  const fields = children(expect(tbs, SEQUENCE, "to-be-signed part"));
  const explicitVersion = fields[0]?.tag === 0xa0 ? fields.shift() : undefined;
  const versionNumber = explicitVersion === undefined ? 0 : contents(expect(children(explicitVersion)[0], INTEGER, "version")).reduce((sum, byte) => sum * 256 + byte, 0);
  const [serialNumber, , issuer, validity, subject] = fields;
  const [notBefore, notAfter] = children(expect(validity, SEQUENCE, "validity"));
  if (notBefore === undefined || notAfter === undefined || issuer === undefined || subject === undefined) throw new CertificateError("the certificate is incomplete");
  const decoded: DecodedCertificate = {
    subject: name(subject), issuer: name(issuer), version: versionNumber + 1, serialNumber: serial(expect(serialNumber, INTEGER, "serial number")),
    notBefore: time(notBefore), notAfter: time(notAfter),
  };
  const extensions = fields.find(field => field.tag === 0xa3);
  const list = extensions === undefined ? [] : children(expect(children(extensions)[0], SEQUENCE, "extension list"));
  const byOid = new Map<string, Element>();
  for (const extension of list) {
    const parts = children(expect(extension, SEQUENCE, "extension"));
    const oid = dotted(expect(parts[0], OID, "extension type"));
    const value = parts.find((part, index) => index > 0 && part.tag !== BOOLEAN);
    const inner = expect(value, OCTETS, "extension value");
    if (!byOid.has(oid)) byOid.set(oid, element(inner.bytes, inner.start, inner.end));
  }
  const alternative = byOid.get("2.5.29.17"), access = byOid.get("1.3.6.1.5.5.7.1.1"), points = byOid.get("2.5.29.31");
  const ocsp = access === undefined ? [] : accessUris(access, OCSP), issuers = access === undefined ? [] : accessUris(access, CA_ISSUERS);
  const crl = points === undefined ? [] : distributionUris(points);
  return {
    ...decoded,
    ...(alternative === undefined ? {} : { subjectAltName: children(expect(alternative, SEQUENCE, "subject alternative names")).map(generalName) }),
    ...(ocsp.length === 0 ? {} : { OCSP: ocsp }),
    ...(issuers.length === 0 ? {} : { caIssuers: issuers }),
    ...(crl.length === 0 ? {} : { crlDistributionPoints: crl }),
  };
}

/** OpenSSL's names of the cipher suites the engine's TLS client negotiates, with their secret bits, by IANA id. */
const CIPHER_SUITES: ReadonlyMap<number, readonly [string, number]> = new Map([
  [0x1301, ["TLS_AES_128_GCM_SHA256", 128]], [0x1302, ["TLS_AES_256_GCM_SHA384", 256]], [0x1303, ["TLS_CHACHA20_POLY1305_SHA256", 256]],
  [0xc02b, ["ECDHE-ECDSA-AES128-GCM-SHA256", 128]], [0xc02c, ["ECDHE-ECDSA-AES256-GCM-SHA384", 256]], [0xcca9, ["ECDHE-ECDSA-CHACHA20-POLY1305", 256]],
  [0xc02f, ["ECDHE-RSA-AES128-GCM-SHA256", 128]], [0xc030, ["ECDHE-RSA-AES256-GCM-SHA384", 256]], [0xcca8, ["ECDHE-RSA-CHACHA20-POLY1305", 256]],
]);

/**
 * What CPython's `cipher()` returns: (OpenSSL's name, protocol version, secret bits). A suite this table does not know
 * keeps its IANA id as its name ("0x1304") and has no known bits (None).
 */
export function cipherOf(suite: number, version: string): readonly [string, string, number | null] {
  const known = CIPHER_SUITES.get(suite);
  return known === undefined ? [`0x${suite.toString(16).padStart(4, "0").toUpperCase()}`, version, null] : [known[0], version, known[1]];
}
