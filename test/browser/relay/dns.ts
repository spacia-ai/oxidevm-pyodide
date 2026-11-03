// Copied from oxidevm-sdk (Apache-2.0) tests/browser/relay-test-dns.ts at 02fac09296cac393ef97371b1fe70145000f9d3f, for the
// internet scenarios of this module (test/browser/harness.ts --internet). Keep it in step with the SDK's copy.
// The relay test peer's DNS: one query datagram in, one answer out, from a fixed table of IPv4 addresses. A name in the
// table answers its A records and no AAAA records; any other name is NXDOMAIN. An EDNS record in the query is ignored.
import assert from "node:assert/strict";

/** Lowercase names without the root dot → their IPv4 addresses. */
export type DnsTable = ReadonlyMap<string, readonly string[]>;

const TYPE_A = 1, CLASS_IN = 1, TTL = 60, NXDOMAIN = 3, FORMERR = 1;

/** The answer to `query`, with the name asked for and the addresses given (none for a malformed query). */
export function answerDns(query: Uint8Array, table: DnsTable): { readonly reply: Uint8Array; readonly name: string | undefined; readonly addresses: readonly string[] } {
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength);
  if (query.byteLength < 12) return { reply: new Uint8Array(), name: undefined, addresses: [] };
  const id = view.getUint16(0), flags = view.getUint16(2), questions = view.getUint16(4);
  const header = (rcode: number, answers: number): Uint8Array => {
    const bytes = new Uint8Array(12), out = new DataView(bytes.buffer);
    out.setUint16(0, id); out.setUint16(2, 0x8000 | (flags & 0x7900) | 0x0080 | rcode); out.setUint16(4, rcode === FORMERR ? 0 : 1); out.setUint16(6, answers);
    return bytes;
  };
  const labels: string[] = [];
  let offset = 12;
  try {
    assert(questions === 1 && (flags & 0x8000) === 0, "one question in a query");
    for (;;) {
      const length = query[offset];
      assert(length !== undefined && length < 64, "a plain label");
      offset += 1;
      if (length === 0) break;
      assert(offset + length <= query.byteLength, "the label fits");
      labels.push(new TextDecoder().decode(query.subarray(offset, offset + length)).toLowerCase());
      offset += length;
    }
    assert(offset + 4 <= query.byteLength, "the question has a type and class");
  } catch {
    return { reply: header(FORMERR, 0), name: undefined, addresses: [] };
  }
  const type = view.getUint16(offset), klass = view.getUint16(offset + 2), question = query.subarray(12, offset + 4);
  const name = labels.join("."), known = table.get(name);
  const addresses = known !== undefined && type === TYPE_A && klass === CLASS_IN ? known : [];
  const records = addresses.map(address => {
    const octets = address.split(".").map(Number);
    assert(octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255), `${address} is IPv4`);
    const record = new Uint8Array(16), out = new DataView(record.buffer);
    out.setUint16(0, 0xc00c); out.setUint16(2, TYPE_A); out.setUint16(4, CLASS_IN); out.setUint32(6, TTL); out.setUint16(10, 4);
    record.set(octets, 12);
    return record;
  });
  const reply = new Uint8Array(12 + question.byteLength + records.length * 16);
  reply.set(header(known === undefined ? NXDOMAIN : 0, records.length));
  reply.set(question, 12);
  records.forEach((record, index) => { reply.set(record, 12 + question.byteLength + index * 16); });
  return { reply, name, addresses };
}
