/**
 * The authorities a program adds with `load_verify_locations`, as the engine's TLS client takes them (engine TLS API 2,
 * `trust`). Most of a CA bundle such as certifi's (which requests loads for every HTTPS request) is already in the VM's
 * own /etc/ssl/cert.pem, which every session trusts anyway, so only the certificates the VM does not have are passed on,
 * one DER certificate per entry: the session trusts exactly the same set, the VM's and the program's, and a connection
 * carries a few kilobytes of authorities instead of the whole bundle. The engine takes at most `MAX_EXTRA_AUTHORITIES`
 * certificates and `MAX_EXTRA_AUTHORITY_BYTES` bytes per session.
 */

/** The most certificates the engine adds to one session (its `MAX_EXTRA_ANCHORS`, the SDK's `MAX_TRUST_ANCHORS`). */
export const MAX_EXTRA_AUTHORITIES = 512;
/** The most bytes of authorities the engine takes for one session (the SDK's `MAX_TRUST_BYTES`). */
export const MAX_EXTRA_AUTHORITY_BYTES = 2 * 1024 * 1024;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu;
const PEM_MARK = "-----BEGIN ";

/** Base64 to bytes, or undefined when it is not base64. */
function base64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/gu, "")), character => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * The certificates of one entry: every CERTIFICATE block of a PEM bundle as DER (a block that is not base64 stays as its
 * PEM text, for the engine to refuse), or the entry itself when it is not PEM (one DER certificate).
 */
export function certificatesOf(entry: Uint8Array): Uint8Array[] {
  const text = new TextDecoder("latin1").decode(entry);
  if (!text.includes(PEM_MARK)) return [entry];
  return [...text.matchAll(PEM_BLOCK)].map(block => base64(block[1] ?? "") ?? new TextEncoder().encode(block[0]));
}

function keyOf(der: Uint8Array): string {
  let key = "";
  for (const byte of der) key += byte.toString(16).padStart(2, "0");
  return key;
}

/** The certificates of a trust store, by their DER, to tell which of a program's authorities the VM already trusts. */
export function storeKeys(store: Uint8Array | undefined): ReadonlySet<string> {
  return new Set(store === undefined ? [] : certificatesOf(store).map(keyOf));
}

/** The program's authorities that the VM's store lacks, each once, in their order, one certificate per entry. */
export function extraAuthorities(entries: readonly Uint8Array[], vm: ReadonlySet<string>): Uint8Array[] {
  const seen = new Set(vm), extra: Uint8Array[] = [];
  for (const certificate of entries.flatMap(certificatesOf)) {
    const key = keyOf(certificate);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(certificate);
  }
  return extra;
}
