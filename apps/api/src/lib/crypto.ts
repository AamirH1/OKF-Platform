import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** URL-safe random token with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens (sessions, API keys, resets, share links) are stored only as SHA-256 hashes. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** A fixed hash verified when the user does not exist, so timing does not reveal accounts. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(await dummyHash, password);
}

export const API_KEY_PREFIX = 'okf_';

/** `okf_<8-char id>_<secret>`: the id is a public lookup prefix; only the full key's hash is stored. */
export function generateApiKey(): { key: string; prefix: string } {
  const id = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
  const secret = randomToken(32);
  const prefix = `${API_KEY_PREFIX}${id}`;
  return { key: `${prefix}_${secret}`, prefix };
}

export function parseApiKey(raw: string): { prefix: string } | null {
  const m = /^(okf_[A-Za-z0-9]{8})_[A-Za-z0-9_-]{40,}$/.exec(raw);
  return m ? { prefix: m[1]! } : null;
}
