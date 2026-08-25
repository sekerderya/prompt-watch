/**
 * A portable UUID v4.
 *
 * `node:crypto`'s randomUUID is unavailable in edge runtimes, and the Web Crypto
 * `crypto.randomUUID` is unavailable on insecure origins. This prefers the
 * strongest source present and degrades in a documented order rather than
 * throwing in whichever environment happens to lack one.
 */

type MaybeCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

function webCrypto(): MaybeCrypto | undefined {
  return (globalThis as { crypto?: MaybeCrypto }).crypto;
}

export function randomId(): string {
  const c = webCrypto();

  if (typeof c?.randomUUID === "function") return c.randomUUID();

  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    // Set the version (4) and variant (10xx) bits per RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  }

  // Last resort. Only reachable on a runtime with no Web Crypto at all; these
  // ids identify a trace, they are not a security boundary.
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  const hex = `${rand()}${rand()}${rand()}${rand()}`;
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `a${hex.slice(17, 20)}-${hex.slice(20)}`
  );
}
