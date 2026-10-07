import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Current password-hash cost: one of OWASP's recommended scrypt settings (N=2^15, r=8, p=3, about
 * 32 MiB and ~0.2 s per hash). Hashes made with older settings still verify and are replaced at
 * the next successful sign-in (see needsRehash).
 */
const CURRENT = { N: 32_768, r: 8, p: 3 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; leave headroom so Node never refuses a supported setting.
  const maxmem = 256 * params.N * params.r;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...params, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Reads a stored hash. Only a bounded range of costs is accepted, so a corrupted or tampered row
 * can neither make sign-in arbitrarily expensive nor downgrade it below the original setting.
 */
function parseHash(stored: string): (ScryptParams & { salt: Buffer; expected: Buffer }) | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = parts.slice(1, 4).map((v) => (/^\d{1,7}$/.test(v) ? Number(v) : NaN)) as [number, number, number];
  const powerOfTwo = Number.isInteger(Math.log2(N));
  if (!powerOfTwo || N < 16_384 || N > 131_072 || r !== 8 || p < 1 || p > 8) return undefined;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return undefined;
  return { N, r, p, salt, expected };
}

/** Hashes a password with scrypt and a random salt. Format: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, CURRENT);
  const { N, r, p } = CURRENT;
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Verifies with the cost the hash was made with. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const actual = await scryptAsync(password, parsed.salt, parsed);
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

/** True when a (verified) stored hash uses an older cost and should be replaced. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.N !== CURRENT.N || parsed.r !== CURRENT.r || parsed.p !== CURRENT.p;
}

/** Opaque session token. Only its SHA-256 hash is stored server-side. */
export function newSessionToken(): string {
  return `dash_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(): string {
  return randomUUID();
}
