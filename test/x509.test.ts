import { describe, expect, it } from "vitest";
import { CertificateError, cipherOf, decodeCertificate } from "../src/x509.ts";

// The decoder's branches, on certificates built here byte by byte. What CPython shows for real certificates (a rich leaf
// and its authority, made by openssl) is compared in test/network.test.ts, through Python's own repr.

function length(size: number): number[] {
  if (size < 0x80) return [size];
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** One DER element. */
function der(tag: number, ...parts: (number[] | Uint8Array)[]): number[] {
  const body = parts.flatMap(part => Array.from(part));
  return [tag, ...length(body.length), ...body];
}

const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const oid = (dotted: string): number[] => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const encoded = [first * 40 + second, ...rest].flatMap(arc => {
    const groups = [arc & 0x7f];
    for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift(0x80 | (value & 0x7f));
    return groups;
  });
  return der(0x06, encoded);
};
const attribute = (type: string, value: number[]): number[] => der(0x30, oid(type), value);
const name = (...relatives: number[][][]): number[] => der(0x30, ...relatives.map(pairs => der(0x31, ...pairs)));
const CN = (text: string): number[] => attribute("2.5.4.3", der(0x0c, ascii(text)));
const utc = (text: string): number[] => der(0x17, ascii(text));
const extension = (type: string, value: number[], critical = false): number[] => der(0x30, oid(type), ...(critical ? [der(0x01, [0xff])] : []), der(0x04, value));

interface Parts {
  readonly version?: number[] | null;
  readonly serial?: number[];
  readonly subject?: number[];
  readonly validity?: number[];
  readonly extensions?: number[][];
}

function certificate(parts: Parts = {}): Uint8Array {
  const version = parts.version === undefined ? der(0xa0, der(0x02, [2])) : parts.version ?? [];
  const tbs = der(0x30, version, parts.serial ?? der(0x02, [0x01]), der(0x30, oid("1.2.840.10045.4.3.2")), name([CN("Issuer")]),
    parts.validity ?? der(0x30, utc("260101093405Z"), utc("270101000000Z")), parts.subject ?? name([CN("Subject")]), der(0x30),
    ...(parts.extensions === undefined ? [] : [der(0xa3, der(0x30, ...parts.extensions))]));
  return Uint8Array.from(der(0x30, tbs, der(0x30, oid("1.2.840.10045.4.3.2")), der(0x03, [0])));
}

describe("decodeCertificate", () => {
  it("decodes the fields CPython always shows, with OpenSSL's names and times", () => {
    expect(decodeCertificate(certificate())).toEqual({
      subject: [[["commonName", "Subject"]]], issuer: [[["commonName", "Issuer"]]], version: 3, serialNumber: "01",
      notBefore: "Jan  1 09:34:05 2026 GMT", notAfter: "Jan  1 00:00:00 2027 GMT",
    });
  });

  it("reads a version 1 certificate, a 20th-century UTCTime and a GeneralizedTime", () => {
    const decoded = decodeCertificate(certificate({ version: null, validity: der(0x30, utc("991231235959Z"), der(0x18, ascii("20510615120000Z"))) }));
    expect([decoded.version, decoded.notBefore, decoded.notAfter]).toEqual([1, "Dec 31 23:59:59 1999 GMT", "Jun 15 12:00:00 2051 GMT"]);
  });

  it("writes serial numbers as OpenSSL does, without the sign byte, and refuses a negative one", () => {
    expect(decodeCertificate(certificate({ serial: der(0x02, [0x00, 0x80, 0x0a]) })).serialNumber).toBe("800A");
    expect(decodeCertificate(certificate({ serial: der(0x02, [0x00]) })).serialNumber).toBe("00");
    expect(() => decodeCertificate(certificate({ serial: der(0x02, [0x80]) }))).toThrow(CertificateError);
  });

  it("decodes every string type of a name, and names an unknown attribute by its dotted identifier", () => {
    const subject = name(
      [attribute("2.5.4.10", der(0x1e, [0x00, 0x5a, 0x01, 0x7c]))],
      [attribute("2.5.4.7", der(0x1c, [0, 0, 0x01, 0x42, 0, 0x01, 0xf6, 0x00]))],
      [attribute("2.5.4.11", der(0x14, [0x47, 0xe9]))],
      [attribute("2.5.4.6", der(0x13, ascii("NL"))), attribute("2.999.1", der(0x16, ascii("x")))],
    );
    expect(decodeCertificate(certificate({ subject })).subject).toEqual([
      [["organizationName", "Zż"]], [["localityName", "ł😀"]], [["organizationalUnitName", "Gé"]], [["countryName", "NL"], ["2.999.1", "x"]],
    ]);
  });

  it("shows every kind of subject alternative name as CPython does", () => {
    const names = der(0x30, der(0xa0, oid("1.2.3"), der(0xa0, der(0x0c, ascii("o")))), der(0x81, ascii("a@b.example")), der(0x82, ascii("b.example")),
      der(0xa3, der(0x30)), der(0xa4, name([CN("Dir")])), der(0xa5, der(0x30)), der(0x86, ascii("https://b.example/")), der(0x87, [192, 0, 2, 1]),
      der(0x87, [0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 1]), der(0x87, [1, 2, 3]), der(0x88, oid("1.2.3.4").slice(2)));
    expect(decodeCertificate(certificate({ extensions: [extension("2.5.29.17", names, true)] })).subjectAltName).toEqual([
      ["othername", "<unsupported>"], ["email", "a@b.example"], ["DNS", "b.example"], ["X400Name", "<unsupported>"], ["DirName", [[["commonName", "Dir"]]]],
      ["EdiPartyName", "<unsupported>"], ["URI", "https://b.example/"], ["IP Address", "192.0.2.1"], ["IP Address", "2001:DB8:0:0:0:0:0:1"],
      ["IP Address", "<invalid>"], ["Registered ID", "1.2.3.4"],
    ]);
    expect(() => decodeCertificate(certificate({ extensions: [extension("2.5.29.17", der(0x30, der(0x89, [0])))] }))).toThrow(CertificateError);
    expect(() => decodeCertificate(certificate({ extensions: [extension("2.5.29.17", der(0x30, der(0xa4)))] }))).toThrow(CertificateError);
  });

  it("lists the OCSP, CA issuer and CRL URIs, leaving out other locations, and omits the keys when there are none", () => {
    const access = der(0x30, der(0x30, oid("1.3.6.1.5.5.7.48.1"), der(0x86, ascii("http://ocsp/"))), der(0x30, oid("1.3.6.1.5.5.7.48.2"), der(0x82, ascii("dns.example"))),
      der(0x30, oid("1.3.6.1.5.5.7.48.2"), der(0x86, ascii("http://ca/"))));
    const points = der(0x30, der(0x30, der(0xa0, der(0xa0, der(0x86, ascii("http://crl/")), der(0x82, ascii("x"))))), der(0x30, der(0xa0, der(0xa1, der(0x30)))), der(0x30, der(0x81, [0])));
    const decoded = decodeCertificate(certificate({ extensions: [extension("1.3.6.1.5.5.7.1.1", access), extension("2.5.29.31", points)] }));
    expect([decoded.OCSP, decoded.caIssuers, decoded.crlDistributionPoints]).toEqual([["http://ocsp/"], ["http://ca/"], ["http://crl/"]]);
    const empty = decodeCertificate(certificate({ extensions: [extension("1.3.6.1.5.5.7.1.1", der(0x30)), extension("2.5.29.31", der(0x30))] }));
    expect(Object.keys(empty)).toEqual(["subject", "issuer", "version", "serialNumber", "notBefore", "notAfter"]);
  });

  it("takes the first of two extensions of one type, as OpenSSL looks them up", () => {
    const first = extension("2.5.29.17", der(0x30, der(0x82, ascii("first.example")))), second = extension("2.5.29.17", der(0x30, der(0x82, ascii("second.example"))));
    expect(decodeCertificate(certificate({ extensions: [first, second] })).subjectAltName).toEqual([["DNS", "first.example"]]);
  });

  it("reads long lengths, and refuses truncated, oversized and unusual encodings", () => {
    expect(decodeCertificate(certificate({ subject: name([CN("x".repeat(300))]) })).subject).toEqual([[["commonName", "x".repeat(300)]]]);
    const whole = certificate();
    for (const broken of [whole.subarray(0, whole.length - 1), Uint8Array.of(0x30), Uint8Array.of(0x30, 0x85, 1, 1, 1, 1, 1), Uint8Array.of(0x30, 0x80), Uint8Array.of(0x1f, 0x01, 0x00),
      Uint8Array.of(0x02, 0x01, 0x00), certificate({ validity: der(0x30, utc("2601010934Z"), utc("270101000000Z")) }), certificate({ validity: der(0x30, utc("261301093405Z"), utc("270101000000Z")) }),
      certificate({ validity: der(0x30, utc("260101093405Z")) }), certificate({ subject: der(0x30, der(0x31, der(0x30, oid("2.5.4.3")))) })]) {
      expect(() => decodeCertificate(broken)).toThrow(CertificateError);
    }
  });
});

describe("cipherOf", () => {
  it("names a suite as OpenSSL does, with its secret bits, and keeps an unknown one's IANA id", () => {
    expect(cipherOf(0x1301, "TLSv1.3")).toEqual(["TLS_AES_128_GCM_SHA256", "TLSv1.3", 128]);
    expect(cipherOf(0x1303, "TLSv1.3")).toEqual(["TLS_CHACHA20_POLY1305_SHA256", "TLSv1.3", 256]);
    expect(cipherOf(0xc030, "TLSv1.2")).toEqual(["ECDHE-RSA-AES256-GCM-SHA384", "TLSv1.2", 256]);
    expect(cipherOf(0x1304, "TLSv1.3")).toEqual(["0x1304", "TLSv1.3", null]);
    expect(cipherOf(0xc, "TLSv1.2")).toEqual(["0x000C", "TLSv1.2", null]);
  });
});
