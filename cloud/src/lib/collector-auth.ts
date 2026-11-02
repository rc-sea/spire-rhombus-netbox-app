import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Repo } from './db/repo';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A new collector secret: 32 random bytes, base64url. Shown once; only the hash is stored. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Resolve the collector for a bearer token. The token is `<collectorId>.<secret>`
 * so the lookup is by id and the comparison is constant-time on the hash.
 */
export async function authenticateCollector(
  repo: Repo,
  authorization: string | null,
): Promise<{ id: string } | null> {
  const m = /^Bearer\s+([^.\s]+)\.([^\s]+)$/i.exec(authorization ?? '');
  if (!m) return null;
  const [, id, secret] = m;
  if (!id || !secret) return null;
  const row = await repo.getCollector(id);
  if (!row) return null;
  return safeEqualHex(hashSecret(secret), row.secretHash) ? { id: row.id } : null;
}
