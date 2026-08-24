const ENCODER = new TextEncoder();

export async function hashValue(value: string): Promise<string> {
  const data = ENCODER.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const hashA = await hashValue(a);
  const hashB = await hashValue(b);

  if (hashA.length !== hashB.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < hashA.length; i++) {
    result |= hashA.charCodeAt(i) ^ hashB.charCodeAt(i);
  }
  return result === 0;
}

export function isAuthEnabled(): boolean {
  const key = process.env.PROMPTWATCH_API_KEY;
  return typeof key === "string" && key.length > 0;
}

export async function isValidApiKey(candidate: string | null): Promise<boolean> {
  if (!isAuthEnabled()) {
    return true;
  }
  if (candidate === null || candidate === undefined || candidate === "") {
    return false;
  }
  return constantTimeEqual(candidate, process.env.PROMPTWATCH_API_KEY!);
}