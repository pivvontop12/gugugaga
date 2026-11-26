import { createHash, generateKeyPairSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const derive = promisify(scrypt);
export const stamp = () => Math.floor(Date.now() / 1000);
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const devicePattern = /^NM2-(?:[A-Z2-7]{8}-){3}[A-Z2-7]{8}$/;

export async function hashPassword(password) {
  const salt = secret(16);
  return salt + '.' + (await derive(password, salt, 64)).toString('hex');
}

export async function matchesPassword(password, record) {
  // Run the same cost for a nonexistent email as for an incorrect password.
  const [salt, hash] = (record || 'dummy.' + '00'.repeat(64)).split('.');
  return timingSafeEqual(await derive(password, salt, 64), Buffer.from(hash, 'hex')) && !!record;
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'portal.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      password TEXT, pin TEXT, discord_id TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'customer'
      CHECK(role IN ('customer','admin')), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS sign_in_attempts (
      hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sign_in_attempts_account ON sign_in_attempts(account_id);
    CREATE TABLE IF NOT EXISTS account_recovery (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      code_hash TEXT NOT NULL UNIQUE, code_suffix TEXT NOT NULL,
      payment_at INTEGER NOT NULL, activated_at INTEGER, duration_days INTEGER, expires_at INTEGER,
      revoked_at INTEGER, device TEXT, device_name TEXT, binding_id TEXT,
      device_at INTEGER, last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL REFERENCES accounts(id),
      customer TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_customer ON events(customer, id DESC);
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name='pin'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name='pin'").get()) {
        db.exec('ALTER TABLE accounts ADD COLUMN pin TEXT; DELETE FROM sessions');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

export function loadSigningKey(directory) {
  const path = join(directory, 'portal-signing.pem');
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  try {
    writeFileSync(path, privateKey, { flag: 'wx', mode: 0o600 });
    return privateKey;
  } catch (error) {
    if (error.code === 'EEXIST') return readFileSync(path, 'utf8');
    throw error;
  }
}

export function licenseStatus(license, time = stamp()) {
  if (!license) return 'Pending approval';
  if (license.revoked_at) return 'Revoked';
  if (!license.activated_at) return 'Awaiting activation';
  if (license.expires_at && license.expires_at <= time) return 'Expired';
  return 'Active';
}
