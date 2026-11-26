import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { digest, hashPassword, stamp } from '../store.mjs';

test('PIN enrollment, account recovery and the full Premium activation workflow', async () => {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const directory = mkdtempSync(join(tmpdir(), 'nova-portal-test-'));
  const release = join(directory, 'release.zip');
  writeFileSync(release, 'test release');
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
    NM_DATA_DIR: directory, PREMIUM_ZIP: release, ADMIN_EMAIL: 'admin@novamacro.local',
    DISCORD_CLIENT_ID: 'unused-client', DISCORD_CLIENT_SECRET: 'unused-secret' };
  const legacyPassword = 'old customer password';
  const oldSession = 'session-before-the-pin-migration';
  const discordId = '123456789123456789';
  const discordAccountId = 'discord-only-customer';
  const discordSession = 'session-from-the-retired-sign-in';
  const discordAttempt = 'attempt-from-the-retired-sign-in';
  const legacy = new DatabaseSync(join(directory, 'portal.sqlite'));
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    password TEXT, discord_id TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'customer', created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL
  )`);
  legacy.prepare('INSERT INTO accounts (id,email,name,password,created_at) VALUES (?,?,?,?,?)')
    .run('existing-customer', 'existing@example.test', 'Existing customer', await hashPassword(legacyPassword), stamp());
  legacy.prepare('INSERT INTO accounts (id,name,discord_id,created_at) VALUES (?,?,?,?)')
    .run(discordAccountId, 'Discord customer', discordId, stamp());
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(oldSession), 'existing-customer', stamp() + 86400);
  legacy.close();
  execFileSync(process.execPath, ['server.mjs', '--setup'], { env });
  const password = readFileSync(join(directory, 'admin-credentials.txt'), 'utf8').match(/^Password: (.+)$/m)[1];
  const migrated = new DatabaseSync(join(directory, 'portal.sqlite'));
  migrated.prepare('UPDATE accounts SET pin=? WHERE id=?').run(await hashPassword('397501'), discordAccountId);
  migrated.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(discordSession), discordAccountId, stamp() + 3600);
  migrated.prepare('INSERT INTO sign_in_attempts VALUES (?,?,?)').run(digest(discordAttempt), discordAccountId, stamp() + 300);
  migrated.close();
  const processHandle = spawn(process.execPath, ['server.mjs'], { env, stdio: 'ignore' });
  const exited = once(processHandle, 'exit');
  async function request(path, { body, cookie, site = origin, expect = 200 } = {}) {
    const headers = cookie ? { cookie } : {};
    if (body !== undefined) Object.assign(headers, { origin: site, 'content-type':'application/json' });
    const res = await fetch(origin + path, { method:body===undefined?'GET':'POST', headers, redirect:'manual',
      body:body===undefined?undefined:JSON.stringify(body) });
    const text = await res.text();
    assert.equal(res.status, expect, path + ' ' + text);
    return { data: res.headers.get('content-type')?.includes('json')?JSON.parse(text):text,
      cookie: res.headers.getSetCookie().map(value => value.split(';')[0]).find(value => !value.endsWith('=')) };
  }
  async function beginLogin(email, password, pending) {
    const attempt = (await request('/api/login', { body:{ email,password } })).cookie;
    assert.match(attempt, /^nm_pending=/);
    const state = (await request('/api/state', { cookie:attempt })).data;
    assert.equal(state.account, null);
    assert.equal(state.pending, pending);
    return attempt;
  }
  async function finishLogin(attempt, pin) {
    const cookie = (await request('/api/auth/pin', { cookie:attempt, body:{ pin } })).cookie;
    assert.match(cookie, /^nm_session=/);
    return cookie;
  }
  try {
    for (let i=0; i<60; i++) {
      try { await request('/api/state'); break; }
      catch (error) { if (i===59) throw error; await sleep(70); }
    }
    assert.doesNotMatch((await request('/app.js')).data,/Continue with Discord/);
    await request('/auth/discord',{expect:404});
    await request('/auth/discord/callback',{expect:404});
    await request('/api/auth/pin',{cookie:'nm_pending=' + discordAttempt,body:{pin:'397501'},expect:401});
    assert.equal((await request('/api/state',{cookie:'nm_session=' + discordSession})).data.account,null);
    await request('/download/premium',{expect:401});
    await request('/download/premium',{cookie:'nm_session=' + oldSession,expect:401});
    const legacyAttempt = await beginLogin('existing@example.test',legacyPassword,'setup');
    const legacySession = await finishLogin(legacyAttempt,'049125');
    assert.equal((await request('/api/state',{cookie:legacySession})).data.account.id,'existing-customer');
    const email = 'first@example.test';
    const initialPassword = 'long safe example passphrase';
    const userDetails = {name:'Test NovaMacro Customer',email,password:initialPassword};
    await request('/api/register',{body:userDetails,expect:400});
    const customer = (await request('/api/register',{body:{...userDetails,pin:'062035'}})).cookie;
    const another = (await request('/api/register',{
      body:{name:'Other customer',email:'other@example.test',password:'another test passphrase',pin:'724013'}
    })).cookie;
    const adminAttempt = await beginLogin(env.ADMIN_EMAIL,password,'setup');
    await request('/api/admin/customers',{cookie:adminAttempt,expect:401});
    const admin = await finishLogin(adminAttempt,'741095');
    const list = (await request('/api/admin/customers',{cookie:admin})).data.customers;
    const discordAccount = list.find(row=>row.discordId===discordId);
    assert.equal(discordAccount.id,discordAccountId);
    assert.equal(discordAccount.method,'Email setup needed');
    const legacyLicense = (await request('/api/admin/action',{cookie:admin,
      body:{customerId:discordAccountId,action:'issue',duration:null,paymentConfirmed:true}})).data.code;
    const discordRecovery = (await request('/api/admin/action',{cookie:admin,
      body:{customerId:discordAccountId,action:'recover'}})).data.code;
    assert.equal((await request('/api/recover/check',{body:{code:discordRecovery}})).data.needsEmail,true);
    const migratedAccount = {code:discordRecovery,email:'migrated@example.test',password:'migrated account password',pin:'308947'};
    await request('/api/recover',{body:{...migratedAccount,email},expect:409});
    await request('/api/recover',{body:migratedAccount});
    const recoveredDiscord = await finishLogin(await beginLogin(migratedAccount.email,migratedAccount.password,'verify'),migratedAccount.pin);
    assert.equal((await request('/api/state',{cookie:recoveredDiscord})).data.account.id,discordAccountId);
    await request('/api/redeem',{cookie:recoveredDiscord,body:{code:legacyLicense}});
    assert.equal((await request('/download/premium',{cookie:recoveredDiscord})).data,'test release');
    const customerInfo = list.find(row=>row.email===email);
    const customerId = customerInfo.id;
    assert.equal(customerInfo.pinConfigured,true);
    assert.equal(Object.hasOwn(customerInfo,'password'),false);
    assert.equal(Object.hasOwn(customerInfo,'pin'),false);
    const attempt = await beginLogin(email,initialPassword,'verify');
    await request('/download/premium',{cookie:attempt,expect:401});
    await request('/api/auth/pin',{cookie:attempt,body:{pin:'666666'},expect:401});
    const secondSession = await finishLogin(attempt,'062035');
    await request('/api/auth/pin',{cookie:attempt,body:{pin:'062035'},expect:401});
    await request('/api/admin/customers',{cookie:customer,expect:403});
    await request('/download/premium',{cookie:customer,expect:403});
    await request('/api/admin/action',{cookie:customer,body:{customerId,action:'issue',duration:30,paymentConfirmed:true},expect:403});
    await request('/api/admin/action',{cookie:admin,body:{customerId,action:'issue',duration:30},expect:400});
    await request('/api/admin/action',{cookie:admin,site:'https://forged.example',body:{customerId,action:'issue',duration:30,paymentConfirmed:true},expect:403});
    const code = (await request('/api/admin/action',{cookie:admin,
      body:{customerId,action:'issue',duration:30,paymentConfirmed:true}})).data.code;
    assert.match(code,/^NMP-/);
    await request('/download/premium',{cookie:customer,expect:403});
    const device = 'NM2-ABCDEFGH-234567AB-CDEFGH23-4567ABCD';
    await request('/api/device',{cookie:customer,body:{device},expect:403});
    await request('/api/redeem',{cookie:another,body:{code},expect:403});
    await request('/api/redeem',{cookie:customer,body:{code}});
    await request('/api/redeem',{cookie:customer,body:{code},expect:409});
    assert.equal((await request('/download/premium',{cookie:customer})).data,'test release');
    await request('/download/premium',{cookie:another,expect:403});
    const key = (await request('/api/device',{cookie:customer,body:{device,name:'Gaming PC'}})).data.key;
    assert.match(key,/^NM3\./);
    const renewed = await request('/api/desktop/renew',{body:{device,key}});
    assert.match(renewed.data.key,/^NM3\./);
    await request('/api/device',{cookie:customer,body:{device:device.replace(/D$/,'E')},expect:409});
    await request('/api/admin/action',{cookie:admin,body:{customerId,action:'duration',duration:1}});
    const state = (await request('/api/state',{cookie:customer})).data;
    assert.equal(state.license.expiresAt - state.license.activatedAt,86400);
    const db = new DatabaseSync(join(directory,'portal.sqlite'));
    db.prepare('UPDATE licenses SET expires_at=1 WHERE account_id=?').run(customerId);
    db.close();
    await request('/download/premium',{cookie:customer,expect:403});
    await request('/api/desktop/renew',{body:{device,key},expect:403});
    await request('/api/admin/action',{cookie:admin,body:{customerId,action:'duration',duration:null}});
    await request('/api/desktop/renew',{body:{device,key}});
    await request('/api/admin/action',{cookie:admin,body:{customerId,action:'reset'}});
    await request('/api/desktop/renew',{body:{device,key},expect:403});
    const newKey = (await request('/api/device',{cookie:customer,body:{device}})).data.key;
    await request('/api/desktop/renew',{body:{device,key:newKey}});

    const pendingAtRecovery = await beginLogin(email,initialPassword,'verify');
    await request('/api/admin/action',{cookie:customer,body:{customerId,action:'recover'},expect:403});
    await request('/api/admin/action',{cookie:admin,body:{customerId:list.find(row=>row.id==='existing-customer').id,action:'recover'}});
    const generateRecovery = async () => (await request('/api/admin/action',{cookie:admin,body:{customerId,action:'recover'}})).data.code;
    const expiredCode = await generateRecovery();
    const accounts = new DatabaseSync(join(directory,'portal.sqlite'));
    accounts.prepare('UPDATE account_recovery SET expires_at=? WHERE account_id=?').run(stamp() - 1, customerId);
    await request('/api/recover/check',{body:{code:expiredCode},expect:400});
    const supersededCode = await generateRecovery();
    const recoveryCode = await generateRecovery();
    assert.match(recoveryCode,/^NMR-[\w-]{32}$/);
    await request('/api/recover/check',{body:{code:supersededCode},expect:400});
    assert.equal((await request('/api/recover/check',{body:{code:recoveryCode}})).data.needsEmail,false);
    const replacement = {code:recoveryCode,password:'new customer password',pin:'439009'};
    await request('/api/recover',{body:{...replacement,pin:'1'},expect:400});
    await request('/api/recover',{body:replacement});
    await request('/api/recover',{body:replacement,expect:400});
    const stored = accounts.prepare('SELECT password,pin FROM accounts WHERE id=?').get(customerId);
    assert.notEqual(stored.password,replacement.password);
    assert.notEqual(stored.pin,replacement.pin);
    accounts.close();
    await request('/api/auth/pin',{cookie:pendingAtRecovery,body:{pin:'062035'},expect:401});
    await request('/download/premium',{cookie:customer,expect:401});
    await request('/download/premium',{cookie:secondSession,expect:401});
    await request('/api/login',{body:{email,password:initialPassword},expect:401});
    const replacementAttempt = await beginLogin(email,replacement.password,'verify');
    await request('/api/auth/pin',{cookie:replacementAttempt,body:{pin:'062035'},expect:401});
    const replacementSession = await finishLogin(replacementAttempt,replacement.pin);
    assert.equal((await request('/download/premium',{cookie:replacementSession})).data,'test release');
    await request('/api/desktop/renew',{body:{device,key:newKey}});
    await request('/api/admin/action',{cookie:admin,body:{customerId,action:'revoke'}});
    await request('/api/desktop/renew',{body:{device,key:newKey},expect:403});
    await request('/download/premium',{cookie:replacementSession,expect:403});
  } finally {
    processHandle.kill();
    await exited;
    rmSync(directory,{recursive:true,force:true});
  }
});
