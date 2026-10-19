import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-function-pools-cli-'));
const file = path.join(root, 'providers.json');
const cli = (...args) => {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', ...args, '--provider-config', file], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: path.join(root, 'unused-host') }, timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const command = (group, verb, input, ...positional) => cli(group, verb, ...positional, '--input', JSON.stringify(input));
const state = () => cli('capabilities', 'list').capabilities.find(row => row.capability === 'image-gen');
try {
  cli('config', 'init');
  command('providers', 'add', { id: 'fixture', auth: 'none', baseUrl: 'http://image.fixture.invalid/v1', mediaProtocol: 'openai-images' });
  assert.deepEqual(state().candidates, []);
  command('models', 'add', { capabilities: ['image-gen'], enableAutomatic: true }, 'fixture::a');
  command('models', 'add', { capabilities: ['image-gen'] }, 'fixture::b');
  assert.deepEqual(state().candidates, ['fixture::a', 'fixture::b']);
  assert.equal(state().mode, 'auto');
  const legacy = JSON.parse(fs.readFileSync(file));
  legacy.assignments['image-gen'] = { providerId: 'fixture', modelId: 'b' };
  fs.writeFileSync(file, JSON.stringify(legacy));
  command('assignments', 'set', { capability: 'image-gen', mode: 'disabled' });
  command('assignments', 'set', { capability: 'image-gen', mode: 'manual' });
  assert.deepEqual(state().candidates, ['fixture::b']);
  legacy.assignments['image-gen'] = [{ providerId: 'fixture', modelId: 'b' }];
  fs.writeFileSync(file, JSON.stringify(legacy));
  command('models', 'caps', { capabilities: ['image-gen'], enableAutomatic: true }, 'fixture::a');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).assignments['image-gen'].models, ['fixture::b']);
  const beforeInvalid = fs.readFileSync(file);
  const invalid = spawnSync(process.execPath, ['bin/dsh-iris.js', 'assignments', 'set', '--provider-config', file,
    '--input', JSON.stringify({ capability: 'image-gen', mode: 'manual', model_refs: [{ providerId: 'fixture', modelId: 'b' }] })], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: path.join(root, 'unused-host') }
  });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.deepEqual(fs.readFileSync(file), beforeInvalid, 'invalid policy references must fail before persisting');
  command('assignments', 'set', { capability: 'image-gen', model_refs: ['fixture::b'] });
  command('models', 'add', { capabilities: ['image-gen'] }, 'fixture::c');
  assert.deepEqual(state().candidates, ['fixture::b']);
  command('assignments', 'set', { capability: 'image-gen', mode: 'disabled' });
  assert.equal(state().mode, 'disabled');
  assert.deepEqual(state().candidates, []);
  command('assignments', 'set', { capability: 'image-gen', mode: 'manual' });
  assert.deepEqual(state().candidates, ['fixture::b']);
  command('assignments', 'set', { capability: 'image-gen', mode: 'auto' });
  assert.deepEqual(state().candidates, ['fixture::a', 'fixture::b', 'fixture::c']);
  const raw = JSON.parse(fs.readFileSync(file));
  raw.providers[0].models.push({ id: 'pending', source: 'discovered', capabilities: ['image-gen'] });
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(state().candidates.includes('fixture::pending'), false);
  command('models', 'caps', { capabilities: ['image-gen'] }, 'fixture::pending');
  assert.equal(state().candidates.includes('fixture::pending'), true);
  assert.equal(cli('config', 'check').valid, true);
  for (const id of ['a', 'b', 'c', 'pending']) cli('models', 'remove', 'fixture::' + id);
  assert.equal(state().mode, 'auto', 'removing models must not erase the function policy');
  assert.deepEqual(state().candidates, []);
  cli('assignments', 'clear', '--input', JSON.stringify({ capability: 'image-gen' }));
  const before = fs.readFileSync(file);
  assert.deepEqual(state().candidates, []);
  assert.deepEqual(fs.readFileSync(file), before, 'legacy cleared configuration remains unchanged by reads');
  console.log('PASS real CLI: one-step model confirmation, automatic/manual/disabled, preserved lists, discovery approval and policy-safe removal');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
