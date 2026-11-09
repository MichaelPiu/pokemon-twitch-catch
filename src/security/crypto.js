// Primitive crittografiche: hashing password (scrypt), cifratura segreti (AES-256-GCM).
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Carica (o genera al primo avvio) la chiave di cifratura dei segreti.
export function loadSecretKey(path, envKey) {
  if (envKey) return createHash('sha256').update(envKey).digest();
  if (existsSync(path)) {
    const k = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (k.length === 32) return k;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* ignora */ }
  return key;
}

export class SecretBox {
  constructor(key) { this.key = key; }

  encrypt(plain) {
    if (plain == null || plain === '') return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }

  decrypt(box) {
    if (!box) return null;
    const [v, ivB, tagB, dataB] = String(box).split(':');
    if (v !== 'v1') throw new Error('Formato segreto non valido');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  }
}
