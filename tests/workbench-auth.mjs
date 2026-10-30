import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWorkbenchAuth, resolveWorkbenchAuthDirectory } from '../lib/workbench-auth.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-workbench-auth'), dataRoot = path.join(root, 'core'), directory = path.join(root, 'auth');
fs.mkdirSync(dataRoot); const checks = [], secret = 'Example-password-123';
let auth = createWorkbenchAuth({ directory, dataRoot });
const originalNow = Date.now;
try {
  const initial = auth.start(); assert.equal(initial.configured, false);
  const setup = new URL(auth.setupLink('http://127.0.0.1:3182')).hash.slice(7);
  await assert.rejects(auth.setup({ ticket: 'A'.repeat(43), password: secret, remember: true }), { code: 'IRIS_WEB_SETUP_REQUIRED' });
  assert.throws(() => auth.setup({ ticket: setup, password: 'short', remember: true }), { code: 'IRIS_WEB_PASSWORD_INPUT_INVALID' });
  const creating = auth.setup({ ticket: setup, password: secret, remember: true });
  assert.throws(() => auth.setup({ ticket: setup, password: secret, remember: true }), { code: 'IRIS_WEB_AUTH_BUSY' });
  const session = await creating; assert.equal(auth.authenticate(session.accessToken), true);
  assert.equal(auth.info().configured, true); assert.equal(session.authId, initial.authId);
  assert.throws(() => auth.setupLink('http://127.0.0.1:3182'), { code: 'IRIS_WEB_PASSWORD_ALREADY_SET' });
  const text = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert(!text.includes(secret) && !text.includes(setup) && !text.includes(session.accessToken));
  if (process.platform !== 'win32') { assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600); }
  checks.push('first ownership proof, asynchronous scrypt, concurrent setup, private storage and zero plaintext password/session persistence');
  const rival = createWorkbenchAuth({ directory, dataRoot });
  assert.throws(() => rival.start(), { code: 'IRIS_CORE_DATA_ROOT_BUSY' }); await rival.dispose();
  await auth.dispose(); auth = createWorkbenchAuth({ directory, dataRoot }); auth.start();
  assert.equal(auth.authenticate(session.accessToken), true); assert.equal(auth.info().authId, initial.authId);
  const tab = await auth.login({ password: secret, remember: false });
  assert.equal(Date.parse(tab.expiresAt) - Date.now() <= 12 * 3600000, true);
  assert.equal(auth.logout(session.accessToken).signedOut, true); assert.equal(auth.authenticate(session.accessToken), false);
  auth.logout(session.accessToken); assert.equal(auth.authenticate(tab.accessToken), true);
  const now = Date.now(); Date.now = () => now + 12 * 3600000;
  assert.equal(auth.authenticate(tab.accessToken), false); Date.now = originalNow;
  checks.push('single writer, stable store identity, normal restart, 12-hour tab expiry, exact session revocation and idempotent logout');
  for (let n = 0; n < 5; n++) await assert.rejects(auth.login({ password: 'wrong-password', remember: false }), { code: 'IRIS_WEB_PASSWORD_INVALID' });
  await assert.rejects(auth.login({ password: secret, remember: false }), { code: 'IRIS_WEB_PASSWORD_RATE_LIMITED' });
  Date.now = () => now + 60001;
  const again = await auth.login({ password: secret, remember: true }); assert.equal(auth.authenticate(again.accessToken), true);
  Date.now = () => Date.parse(again.expiresAt);
  assert.equal(auth.authenticate(again.accessToken), false); Date.now = originalNow;
  await auth.reset(); assert.equal(auth.info().configured, false); assert.equal(auth.authenticate(tab.accessToken), false);
  assert.notEqual(new URL(auth.setupLink('http://127.0.0.1:3182')).hash.slice(7), setup);
  checks.push('bounded failed attempts, recovery after the window, 30-day expiry and reset revocation without a Core write');
  const current = fs.readFileSync(path.join(directory, 'state.json'));
  fs.appendFileSync(path.join(directory, 'state.json'), ' ');
  await assert.rejects(auth.reset(), { code: 'IRIS_WEB_AUTH_CONFIG_CHANGED' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'state.json')), Buffer.concat([current, Buffer.from(' ')]));
  await auth.dispose();
  const otherRoot = path.join(root, 'other'); fs.mkdirSync(otherRoot);
  const foreign = createWorkbenchAuth({ directory, dataRoot: otherRoot });
  assert.throws(() => foreign.start(), { code: 'IRIS_WEB_AUTH_CONFIG_INVALID' }); await foreign.dispose();
  const inside = createWorkbenchAuth({ directory: path.join(dataRoot, 'auth'), dataRoot });
  assert.throws(() => inside.start(), { code: 'IRIS_WEB_AUTH_CONFIG_INVALID' }); await inside.dispose();
  const publicDirectory = path.join(root, 'public'); fs.mkdirSync(publicDirectory, { mode: 0o755 });
  if (process.platform !== 'win32') {
    const unsafe = createWorkbenchAuth({ directory: publicDirectory, dataRoot });
    assert.throws(() => unsafe.start(), { code: 'IRIS_WEB_AUTH_CONFIG_INVALID' }); await unsafe.dispose();
  }
  const link = path.join(root, 'alias'); fs.symlinkSync(directory, link, 'dir');
  const linked = createWorkbenchAuth({ directory: link, dataRoot });
  assert.throws(() => linked.start(), { code: 'IRIS_WEB_AUTH_CONFIG_INVALID' }); await linked.dispose();
  assert.deepEqual(fs.readdirSync(dataRoot), []);
  assert.notEqual(resolveWorkbenchAuthDirectory(dataRoot), resolveWorkbenchAuthDirectory(otherRoot));
  assert.throws(() => resolveWorkbenchAuthDirectory(dataRoot, 'relative'), { code: 'IRIS_WEB_AUTH_CONFIG_INVALID' });
  checks.push('outside edits, foreign-root binding, unsafe permissions/symlinks and Core-root writes are rejected without repair or chmod');
  console.log(JSON.stringify({ ok: true, checks }));
} finally { Date.now = originalNow; await auth.dispose(); }
