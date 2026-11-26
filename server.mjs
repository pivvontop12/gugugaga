import { createServer } from 'node:http';
import { createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { devicePattern, digest, hashPassword, licenseStatus, loadSigningKey, matchesPassword, openStore, secret, stamp } from './store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:' + port);
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
const trustLocalProxy = process.env.TRUST_LOCAL_PROXY === '1';
if ((origin.protocol !== 'https:' && !(loopback && origin.protocol === 'http:')) ||
    origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
  throw new Error('PUBLIC_ORIGIN must be an HTTPS origin, or an HTTP loopback origin for local development.');
}
const directory = resolve(process.env.NM_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'NovaMacro Portal'));
const release = resolve(process.env.PREMIUM_ZIP || join(directory, 'downloads', 'NovaMacro-Premium.zip'));
const supportUrl = process.env.DISCORD_SUPPORT_URL || 'https://discord.gg/sXxVXtgSzu';
const db = openStore(directory);
const signer = loadSigningKey(directory);
const verifier = createPublicKey(signer);
const publicKeyHex = verifier.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const leaseLifetime = 24 * 60 * 60;
const signInLifetime = 5 * 60;
const recoveryLifetime = 15 * 60;

if (process.argv.includes('--public-key')) {
  console.log(publicKeyHex);
  process.exit(0);
}
if (process.argv.includes('--setup')) {
  const credentialsPath = join(directory, 'admin-credentials.txt');
  if (db.prepare("SELECT id FROM accounts WHERE role = 'admin'").get()) {
    console.log('Admin already initialized. Credentials file: ' + credentialsPath);
    process.exit(0);
  }
  const password = secret(24);
  const email = (process.env.ADMIN_EMAIL || 'admin@novamacro.local').trim().toLowerCase();
  db.prepare('INSERT INTO accounts (id,email,name,password,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), email, 'NovaMacro Admin', await hashPassword(password), 'admin', stamp());
  writeFileSync(credentialsPath, 'NovaMacro Portal\n' + origin.origin + '\n\nEmail: ' + email +
    '\nPassword: ' + password + '\n', { mode: 0o600 });
  console.log('Admin created. Credentials file: ' + credentialsPath);
  process.exit(0);
}
if (!db.prepare("SELECT id FROM accounts WHERE role = 'admin'").get()) {
  throw new Error('Run npm run setup before starting the portal.');
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/novamacro.png', ['novamacro.png', 'image/png']]
].map(([url, [file, type]]) => [url, [readFileSync(join(root, 'public', file)), type]]));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function requireThat(value, status, message) {
  if (!value) throw new HttpError(status, message);
}
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json',
    415, 'Send JSON data.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    requireThat(length <= 8192, 413, 'Request is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch {
    throw new HttpError(400, 'Invalid request.');
  }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'Invalid data.');
  return value;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split('; ').map(value => value.split(/=(.*)/s).slice(0, 2)));
}
function cookie(res, key, value, age) {
  const current = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...current, key + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age +
    (origin.protocol === 'https:' ? '; Secure' : '')]);
}
function sessionAccount(req) {
  const token = cookies(req).nm_session;
  if (!token) return null;
  return db.prepare(`SELECT accounts.* FROM sessions JOIN accounts ON sessions.account_id=accounts.id
    WHERE hash=? AND expires_at>? AND accounts.email IS NOT NULL AND accounts.password IS NOT NULL AND accounts.pin IS NOT NULL`)
    .get(digest(token), stamp());
}
function signIn(res, id) {
  const token = secret();
  const duration = 14 * 86400;
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(stamp());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), id, stamp() + duration);
  cookie(res, 'nm_session', token, duration);
}
function pendingSignIn(req) {
  const token = cookies(req).nm_pending;
  if (!token) return null;
  return db.prepare(`SELECT accounts.* FROM sign_in_attempts
    JOIN accounts ON sign_in_attempts.account_id=accounts.id
    WHERE sign_in_attempts.hash=? AND sign_in_attempts.expires_at>?
    AND accounts.email IS NOT NULL AND accounts.password IS NOT NULL`).get(digest(token), stamp());
}
function clearPendingSignIn(req, res) {
  const token = cookies(req).nm_pending;
  if (token) {
    db.prepare('DELETE FROM sign_in_attempts WHERE hash=?').run(digest(token));
    if (res) cookie(res, 'nm_pending', '', 0);
  }
}
function beginSignIn(req, res, id) {
  const token = secret();
  const now = stamp();
  clearPendingSignIn(req);
  db.prepare('DELETE FROM sign_in_attempts WHERE expires_at<=?').run(now);
  db.prepare('INSERT INTO sign_in_attempts VALUES (?,?,?)').run(digest(token), id, now + signInLifetime);
  cookie(res, 'nm_pending', token, signInLifetime);
}
function publicAccount(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role,
    method: row.email ? 'Email' : 'Email setup needed', joinedAt: row.created_at } : null;
}
function requireUser(req) {
  const account = sessionAccount(req);
  requireThat(account, 401, 'Sign in to continue.');
  return account;
}
function licenseFor(id) {
  return db.prepare('SELECT * FROM licenses WHERE account_id=?').get(id);
}
function publicLicense(row) {
  return row && { status: licenseStatus(row), suffix: row.code_suffix, paymentAt: row.payment_at,
    activatedAt: row.activated_at, duration: row.duration_days, expiresAt: row.expires_at,
    device: row.device ? { code: row.device, name: row.device_name, linkedAt: row.device_at, lastSeen: row.last_seen } : null };
}
function event(actor, customer, kind) {
  db.prepare('INSERT INTO events (actor,customer,kind,at) VALUES (?,?,?,?)').run(actor, customer, kind, stamp());
}
function activity(id) {
  return db.prepare('SELECT kind, at FROM events WHERE customer=? ORDER BY id DESC LIMIT 20').all(id);
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function days(value) {
  if (value === null) return null;
  requireThat(Number.isInteger(value) && value >= 1 && value <= 3650, 400, 'Enter 1 to 3650 days or choose Lifetime.');
  return value;
}
function expiry(duration, start) {
  return duration && start ? start + duration * 86400 : null;
}
function desktopLease(account, row) {
  const time = stamp();
  const data = { product: 'novamotion-premium', major: 2, license_id: row.id, binding_id: row.binding_id,
    device: row.device, customer: account.name, portal: origin.origin,
    expires_at: Math.min(time + leaseLifetime, row.expires_at || Infinity) };
  const raw = Buffer.from(JSON.stringify(data));
  return 'NM3.' + raw.toString('base64url') + '.' + sign(null, raw, signer).toString('base64url');
}
function parseLease(value) {
  requireThat(typeof value === 'string' && /^NM3\.[\w-]+\.[\w-]+$/.test(value), 401, 'Invalid desktop key.');
  const [, text, signature] = value.split('.');
  const raw = Buffer.from(text, 'base64url');
  requireThat(verify(null, raw, verifier, Buffer.from(signature, 'base64url')), 401, 'Invalid desktop key.');
  return JSON.parse(raw);
}
function releaseInfo() {
  if (!existsSync(release)) return { available: false };
  const hashFile = release + '.sha256';
  const sha256 = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim().split(/\s+/)[0] : null;
  return { available: true, size: statSync(release).size, version: process.env.PREMIUM_VERSION || '2.6.4',
    sha256: sha256 && /^[a-f0-9]{64}$/i.test(sha256) ? sha256 : null };
}
const hits = new Map();
function limitKey(key, max, window) {
  const now = stamp();
  for (const [expiredKey, entry] of hits) if (entry.until <= now) hits.delete(expiredKey);
  const entry = hits.get(key) || { count: 0, until: now + window };
  requireThat(entry.count < max, 429, 'Too many attempts. Try again later.');
  entry.count++;
  hits.set(key, entry);
}
function limit(req, route, max, window = 900) {
  const address = req.socket.remoteAddress;
  const forwarded = req.headers['x-forwarded-for']?.split(',').at(-1).trim();
  const client = trustLocalProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) &&
    forwarded && isIP(forwarded) ? forwarded : address;
  limitKey(client + ':' + route, max, window);
}
function emailOf(value) {
  requireThat(typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()),
    400, 'Enter a valid email address.');
  return value.trim().toLowerCase();
}
function passwordOf(value, minimum = 1) {
  requireThat(typeof value === 'string' && value.length >= minimum && value.length <= 128,
    400, minimum > 1 ? 'Choose a password with at least ' + minimum + ' characters.' : 'Enter your password.');
  return value;
}
function pinOf(value) {
  requireThat(typeof value === 'string' && /^[0-9]{6,8}$/.test(value), 400, 'Enter a PIN with 6 to 8 digits.');
  return value;
}
async function register(req, res, data) {
  limit(req, 'register', 12);
  const email = emailOf(data.email);
  const password = passwordOf(data.password, 10);
  const pin = pinOf(data.pin);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  requireThat(name.length >= 2 && name.length <= 80, 400, 'Enter a name between 2 and 80 characters.');
  const hashedPassword = await hashPassword(password);
  const hashedPin = await hashPassword(pin);
  const id = randomUUID();
  transaction(() => {
    const result = db.prepare('INSERT OR IGNORE INTO accounts (id,email,name,password,pin,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, email, name, hashedPassword, hashedPin, stamp());
    requireThat(result.changes === 1, 409, 'An account already uses this email. Sign in instead.');
    event(id, id, 'Account registered');
  });
  clearPendingSignIn(req, res);
  signIn(res, id);
  json(res, { ok: true });
}
async function login(req, res, data) {
  limit(req, 'login', 30);
  const email = emailOf(data.email);
  const password = passwordOf(data.password);
  const row = db.prepare('SELECT id,password FROM accounts WHERE email=?').get(email);
  requireThat(await matchesPassword(password, row?.password)
    && db.prepare('SELECT password FROM accounts WHERE id=?').get(row.id)?.password === row.password,
    401, 'Email or password is incorrect.');
  beginSignIn(req, res, row.id);
  json(res, { ok: true });
}
async function completeSignIn(req, res, data) {
  limit(req, 'pin', 30);
  const row = pendingSignIn(req);
  requireThat(row, 401, 'Sign-in expired. Start again.');
  const pin = pinOf(data.pin);
  limitKey('account-pin:' + row.id, 6, 900);
  let hashedPin = row.pin;
  if (hashedPin) {
    requireThat(await matchesPassword(pin, hashedPin), 401, 'The PIN is incorrect.');
  } else {
    hashedPin = await hashPassword(pin);
  }
  transaction(() => {
    const current = pendingSignIn(req);
    requireThat(current?.id === row.id && current.pin === row.pin, 401, 'Sign-in expired. Start again.');
    if (!row.pin) {
      db.prepare('UPDATE accounts SET pin=? WHERE id=?').run(hashedPin, row.id);
      event(row.id, row.id, 'Personal PIN configured');
    }
    clearPendingSignIn(req, res);
    signIn(res, row.id);
  });
  hits.delete('account-pin:' + row.id);
  json(res, { ok: true });
}

async function recoverAccount(req, res, data, checkOnly) {
  limit(req, 'recovery', 18);
  const code = typeof data.code === 'string' ? data.code.trim() : '';
  const invalid = 'This recovery code is invalid or expired. Ask support for a new code.';
  requireThat(/^NMR-[A-Za-z0-9_-]{32}$/.test(code), 400, invalid);
  const hash = digest(code);
  const row = db.prepare(`SELECT accounts.id, accounts.email FROM account_recovery
    JOIN accounts ON account_recovery.account_id=accounts.id WHERE hash=? AND expires_at>?`).get(hash, stamp());
  requireThat(row, 400, invalid);
  if (checkOnly) return json(res, { needsEmail: !row.email });
  const email = row.email || emailOf(data.email);
  const pin = pinOf(data.pin);
  const password = passwordOf(data.password, 10);
  const hashedPin = await hashPassword(pin);
  const hashedPassword = await hashPassword(password);
  transaction(() => {
    const used = db.prepare('DELETE FROM account_recovery WHERE account_id=? AND hash=? AND expires_at>?')
      .run(row.id, hash, stamp());
    requireThat(used.changes === 1, 400, invalid);
    const updated = db.prepare('UPDATE OR IGNORE accounts SET email=?,password=?,pin=? WHERE id=?')
      .run(email, hashedPassword, hashedPin, row.id);
    requireThat(updated.changes === 1, 409, 'This email already belongs to an account. Choose another email.');
    db.prepare('DELETE FROM sessions WHERE account_id=?').run(row.id);
    db.prepare('DELETE FROM sign_in_attempts WHERE account_id=?').run(row.id);
    event(row.id, row.id, 'Account credentials reset');
  });
  hits.delete('account-pin:' + row.id);
  clearPendingSignIn(req, res);
  json(res, { ok: true });
}
function adminAction(account, data) {
  requireThat(account.role === 'admin', 403, 'Administrator access required.');
  requireThat(typeof data.customerId === 'string' &&
    db.prepare("SELECT id FROM accounts WHERE id=? AND role='customer'").get(data.customerId), 404, 'Customer not found.');
  const target = data.customerId;
  return transaction(() => {
    const now = stamp();
    if (data.action === 'recover') {
      const code = 'NMR-' + secret(24);
      db.prepare(`INSERT INTO account_recovery (account_id,hash,expires_at) VALUES (?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET hash=excluded.hash, expires_at=excluded.expires_at`)
        .run(target, digest(code), now + recoveryLifetime);
      event(account.id, target, 'Account recovery code issued');
      return { code };
    }
    const row = licenseFor(target);
    if (data.action === 'issue') {
      requireThat(data.paymentConfirmed === true, 400, 'Confirm that you verified payment.');
      requireThat(!row || row.revoked_at || licenseStatus(row)==='Expired', 409, 'Revoke the existing key before issuing another.');
      const duration = days(data.duration);
      const code = 'NMP-' + secret(19).toUpperCase();
      if (row) db.prepare('DELETE FROM licenses WHERE account_id=?').run(target);
      db.prepare('INSERT INTO licenses (id,account_id,code_hash,code_suffix,payment_at,duration_days) VALUES (?,?,?,?,?,?)')
        .run(secret(16), target, digest(code), code.slice(-5), now, duration);
      event(account.id, target, 'Payment approved and portal key issued');
      return { code };
    }
    requireThat(row && !row.revoked_at, 409, 'There is no valid key to manage.');
    if (data.action === 'duration') {
      const duration = days(data.duration);
      db.prepare('UPDATE licenses SET duration_days=?, expires_at=? WHERE id=?')
        .run(duration, expiry(duration, row.activated_at), row.id);
      event(account.id, target, 'License duration updated');
    } else if (data.action === 'revoke') {
      db.prepare('UPDATE licenses SET revoked_at=? WHERE id=?').run(now, row.id);
      event(account.id, target, 'Key revoked by administrator');
    } else if (data.action === 'reset') {
      db.prepare('UPDATE licenses SET device=NULL, device_name=NULL, binding_id=NULL, device_at=NULL, last_seen=NULL WHERE id=?').run(row.id);
      event(account.id, target, 'Device reset by administrator');
    } else throw new HttpError(400, 'Unknown action.');
    return { ok: true };
  });
}

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  if (origin.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, origin);
  const path = url.pathname;
  if (req.method === 'GET') {
    if (assets.has(path)) {
      const [body, type] = assets.get(path);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    }
    if (path === '/api/state') {
      const account = sessionAccount(req);
      const pending = account ? null : pendingSignIn(req);
      return json(res, { account: publicAccount(account), supportUrl,
        pending: pending ? (pending.pin ? 'verify' : 'setup') : null,
        license: account ? publicLicense(licenseFor(account.id)) : null,
        activity: account ? activity(account.id) : [], release: releaseInfo() });
    }
    if (path === '/download/premium') {
      const account = requireUser(req);
      requireThat(licenseStatus(licenseFor(account.id)) === 'Active', 403, 'Activate your Premium key before downloading.');
      requireThat(existsSync(release), 503, 'The Premium build is being prepared.');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': statSync(release).size,
        'Content-Disposition': 'attachment; filename="NovaMacro-Premium.zip"' });
      return pipeline(createReadStream(release), res);
    }
    if (path === '/api/admin/customers') {
      requireThat(requireUser(req).role === 'admin', 403, 'Administrator access required.');
      const accounts = db.prepare("SELECT * FROM accounts WHERE role='customer' ORDER BY created_at DESC, id DESC").all();
      return json(res, { customers: accounts.map(row => ({ ...publicAccount(row),
        discordId: row.email ? null : row.discord_id, pinConfigured: Boolean(row.pin),
        license: publicLicense(licenseFor(row.id)), events: activity(row.id) })) });
    }
    throw new HttpError(404, 'Page not found.');
  }
  requireThat(req.method === 'POST', 405, 'Method not allowed.');
  if (path === '/api/desktop/renew') {
    const data = await readBody(req);
    const claims = parseLease(data.key);
    const row = db.prepare('SELECT * FROM licenses WHERE id=?').get(claims.license_id);
    requireThat(licenseStatus(row)==='Active' && row.binding_id===claims.binding_id &&
      row.device===claims.device && data.device===claims.device, 403, 'This activation has been revoked, transferred or expired.');
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(row.account_id);
    db.prepare('UPDATE licenses SET last_seen=? WHERE id=?').run(stamp(), row.id);
    return json(res, { key: desktopLease(account, row) });
  }
  requireThat(req.headers.origin === origin.origin, 403, 'Open the portal directly and try again.');
  const data = await readBody(req);
  if (path === '/api/register') return register(req, res, data);
  if (path === '/api/login') return login(req, res, data);
  if (path === '/api/auth/pin') return completeSignIn(req, res, data);
  if (path === '/api/auth/cancel') {
    clearPendingSignIn(req, res);
    return json(res, { ok: true });
  }
  if (path === '/api/recover/check' || path === '/api/recover') {
    return recoverAccount(req, res, data, path.endsWith('/check'));
  }
  const account = requireUser(req);
  if (path === '/api/logout') {
    db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(cookies(req).nm_session));
    cookie(res, 'nm_session', '', 0);
    return json(res, { ok: true });
  }
  if (path === '/api/admin/action') return json(res, adminAction(account, data));
  requireThat(account.role === 'customer', 403, 'A customer account is required.');
  if (path === '/api/redeem') {
    limit(req, 'redeem:' + account.id, 16);
    const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
    requireThat(/^NMP-[A-Z0-9_-]{26}$/.test(code), 400, 'Enter the complete portal key.');
    transaction(() => {
      const row = licenseFor(account.id);
      requireThat(row && !row.revoked_at && row.code_hash===digest(code), 403, 'This key is unavailable for your account.');
      requireThat(!row.activated_at, 409, 'This key has already been activated.');
      const now = stamp();
      db.prepare('UPDATE licenses SET activated_at=?, expires_at=? WHERE id=?').run(now, expiry(row.duration_days, now), row.id);
      event(account.id, account.id, 'Portal key activated');
    });
    return json(res, { ok: true });
  }
  if (path === '/api/device') {
    limit(req, 'device:' + account.id, 30);
    const device = typeof data.device === 'string' ? data.device.trim().toUpperCase() : '';
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 60) : '';
    requireThat(devicePattern.test(device), 400, 'Paste the complete NM2 device code from NovaMacro Premium.');
    const row = transaction(() => {
      const old = licenseFor(account.id);
      requireThat(licenseStatus(old)==='Active', 403, 'Activate your portal key first.');
      requireThat(!old.device || old.device===device, 409, 'A PC is already linked. Contact support for a device reset.');
      if (!old.device) {
        db.prepare('UPDATE licenses SET device=?,device_name=?,binding_id=?,device_at=? WHERE id=?')
          .run(device, name || 'Windows PC', secret(16), stamp(), old.id);
        event(account.id, account.id, 'Windows device linked');
      }
      return licenseFor(account.id);
    });
    return json(res, { key: desktopLease(account, row) });
  }
  throw new HttpError(404, 'Page not found.');
}

createServer((req, res) => {
  handle(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    if (!(error instanceof HttpError)) console.error(error.message);
    json(res, { error: error instanceof HttpError ? error.message : 'Something went wrong. Try again.' }, error.status || 500);
  });
}).listen(port, host, () => console.log('NovaMacro Portal: ' + origin.origin));
