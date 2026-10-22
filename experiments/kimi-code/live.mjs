/** Opt-in live Kimi/Iris experiment. Never part of the published runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const self = fileURLToPath(import.meta.url);
const cliFile = path.resolve(path.dirname(self), '../../bin/dsh-iris.js');
const prompt = '画一个二次元美少女';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });

async function run(command, args, { cwd, env = process.env, timeoutMs = 240000, logs } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError, timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; if (logs) fs.appendFileSync(logs + '.stdout.jsonl', chunk, { mode: 0o600 }); });
  child.stderr.on('data', chunk => { stderr += chunk; if (logs) fs.appendFileSync(logs + '.stderr.log', chunk, { mode: 0o600 }); });
  child.once('error', error => { spawnError = error.code; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
  const [status, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  clearTimeout(timer); clearTimeout(killTimer);
  return { status, signal, timedOut, spawnError, stdout, stderr };
}

async function cli(workspace, args) {
  const result = await run(process.execPath, [cliFile, ...args, '--data-root', path.join(workspace, 'core')], {
    cwd: workspace, env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', DSH_HOME: path.join(workspace, 'unused-dsh-home') },
    timeoutMs: 180000
  });
  assert.equal(result.status, 0, 'Iris CLI failed: ' + result.stderr.slice(0, 1500));
  assert(!result.timedOut && !result.signal, 'Iris CLI interrupted; do not resubmit');
  return JSON.parse(result.stdout);
}

async function operation(workspace, name) {
  const trial = read(path.join(workspace, 'trial.json'));
  assert.equal(trial.kind, 'iris-kimi-live-v1');
  const stateFile = path.join(workspace, 'generation-result.json');
  if (name === 'generate_once' && !fs.existsSync(stateFile)) {
    // Persist intention BEFORE starting the CLI. A crash may leave unknown acceptance.
    save(path.join(workspace, 'generation-intent.json'), { at: new Date().toISOString(), prompt, modelRef: trial.modelRef });
    const result = await cli(workspace, ['run', 'image', '--provider-config', path.join(workspace, 'providers.json'),
      '--input', JSON.stringify({ prompt, model_ref: trial.modelRef, n: 1 })]);
    save(stateFile, result);
  }
  assert(fs.existsSync(stateFile), 'No completed CLI result. Preserve the original intent; do not resubmit.');
  const original = read(stateFile);
  assert(original.task?.id, 'CLI result has no Task');
  const { task } = await cli(workspace, ['task', 'inspect', original.task.id]);
  const summary = { taskId: task.id, outcome: task.outcome, acceptance: task.acceptance, deliveryState: task.deliveryState,
    modelRef: task.modelRef, artifactIds: task.artifactIds, attempts: task.attempts.length };
  let image;
  if (task.artifactIds.length) {
    const id = task.artifactIds[0];
    const inspected = await cli(workspace, ['artifact', 'inspect', id]);
    assert(inspected.artifact.mediaType?.startsWith('image/'), 'Artifact is not an image');
    const file = path.join(workspace, 'result.image');
    if (!fs.existsSync(file)) await cli(workspace, ['artifact', 'export', id, '--output', file]);
    const bytes = fs.readFileSync(file), metadata = await sharp(bytes).metadata();
    Object.assign(summary, { artifactId: id, imagePath: file, imageSha256: hash(bytes), width: metadata.width,
      height: metadata.height, format: metadata.format, bytes: bytes.length });
    if (name === 'generate_once' || name === 'read_result') image = { type: 'image', mimeType: 'image/' + (metadata.format === 'jpg' ? 'jpeg' : metadata.format), data: bytes.toString('base64') };
  }
  append(path.join(workspace, 'operations.jsonl'), { operation: name, ...summary });
  return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...(image ? [image] : [])] };
}

async function mcp(workspace) {
  assert(path.isAbsolute(workspace));
  assert.equal(read(path.join(workspace, 'trial.json')).kind, 'iris-kimi-live-v1');
  save(path.join(workspace, 'mcp-process.json'), { pid: process.pid });
  const descriptions = {
    generate_once: 'Generate exactly one image for the current user prompt through Iris. Returns real image bytes and persistent Task/Artifact identities. A repeat call reads the original result; never resubmits.',
    inspect_task: 'Read the original Iris Task and Artifact state without any generation or retry.',
    read_result: 'Read the original generated image. Never submits or retries generation.'
  };
  const tools = Object.entries(descriptions).map(([name, description]) => ({ name, description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'iris-live-experiment', version: '0.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call') {
        assert(Object.hasOwn(descriptions, request.params?.name), 'Unknown trial tool');
        const args = request.params.arguments ?? {};
        assert(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0, 'Tools accept no arguments');
        append(path.join(workspace, 'tool-calls.jsonl'), { name: request.params.name, at: new Date().toISOString() });
        result = await operation(workspace, request.params.name);
      } else throw new Error('Unsupported trial MCP method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32602, message: error.message } }) + '\n');
      else throw error;
    }
  }
}

async function loadSelectedConfig(auth) {
  // Credentials cross a private child-process pipe only; never print this result.
  const source = [
    'import json,os,pathlib,tomllib',
    'h=pathlib.Path(os.environ.get("KIMI_CODE_HOME",str(pathlib.Path.home()/".kimi-code")))',
    'c=tomllib.loads((h/"config.toml").read_text())',
    'alias="local/kimi-k3" if ' + JSON.stringify(auth) + ' == "local" else c["default_model"]',
    'm=c["models"][alias]; p=c["providers"][m["provider"]]',
    'f=pathlib.Path(os.environ.get("DSH_HOME",str(pathlib.Path.home()/".dsh")))/"iris/v1/providers.json"',
    'catalog=json.loads(f.read_text()); image=next(p for p in catalog["providers"] if p["id"]=="iris_x4ssb6")',
    'print(json.dumps({"alias":alias,"model":m,"provider":p,"thinking":c.get("thinking",{}),"credentials":str(h/"credentials"),"image":image}))'
  ].join('\n');
  const result = await run('python3', ['-c', source], { timeoutMs: 15000 });
  assert.equal(result.status, 0, 'Could not read selected existing configuration');
  return JSON.parse(result.stdout);
}

function minimalEnv(workspace) {
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'LD_LIBRARY_PATH'];
  return { ...Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    KIMI_CODE_HOME: path.join(workspace, 'kimi-home'), KIMI_CODE_TRUST_WORKSPACE: '1',
    KIMI_LOOP_MAX_STEPS_PER_TURN: '8', KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '1', DSH_HOME: path.join(workspace, 'unused-dsh-home') };
}

async function live(output, auth, kimi) {
  assert(['local', 'oauth'].includes(auth), '--auth must be local or oauth');
  assert(path.isAbsolute(output) && !fs.existsSync(output), '--output must be a new absolute directory');
  const selected = await loadSelectedConfig(auth);
  const mediaModel = selected.image.models.find(model => model.id === 'gemini-image');
  assert(selected.image.enabled && mediaModel?.capabilities.includes('image-gen'), 'Selected image model is not enabled');
  assert.equal(selected.image.mediaProtocol, 'openai-responses-images', 'Recheck provider protocol before live execution');
  const modelRef = selected.image.id + '::' + mediaModel.id;
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const workspace = path.join(output, 'workspace'), home = path.join(workspace, 'kimi-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, 'skills'), { mode: 0o700 });
  save(path.join(workspace, 'trial.json'), { kind: 'iris-kimi-live-v1', auth, prompt, modelRef });
  const requests = [];
  let submissions = 0;
  const proxy = http.createServer(async (request, response) => {
    const entry = { at: new Date().toISOString(), method: request.method, path: request.url };
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer isolated-live-proxy');
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert(length < 1024 * 1024); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
      assert.equal(body.model, mediaModel.id); assert(JSON.stringify(body).includes(prompt), 'Prompt changed');
      assert.equal(submissions, 0, 'One image submission per route; do not retry');
      submissions++; Object.assign(entry, { submission: submissions, model: body.model, requestSha256: hash(bytes) });
      requests.push(entry);
      append(path.join(output, 'media-requests.jsonl'), { ...entry, event: 'submit' });
      const upstream = await fetch((selected.image.mediaBaseUrl || selected.image.baseUrl).replace(/\/+$/, '') + '/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + selected.image.apiKey },
        body: bytes, signal: AbortSignal.timeout(150000), redirect: 'error'
      });
      const result = Buffer.from(await upstream.arrayBuffer());
      Object.assign(entry, { status: upstream.status, responseBytes: result.length, responseSha256: hash(result) });
      append(path.join(output, 'media-requests.jsonl'), { ...entry, event: 'response' });
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      response.end(result);
    } catch (error) {
      entry.error = error.name;
      append(path.join(output, 'media-requests.jsonl'), { ...entry, event: 'error' });
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Isolated live proxy failed; preserve original Task and do not resubmit.', type: error.name } }));
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const provider = { id: selected.image.id, name: 'Isolated live image route', type: selected.image.type, enabled: true,
    baseUrl: 'http://127.0.0.1:' + proxy.address().port + '/v1', apiKey: 'isolated-live-proxy',
    mediaProtocol: selected.image.mediaProtocol, models: [{ id: mediaModel.id, capabilities: ['image-gen'] }] };
  save(path.join(workspace, 'providers.json'), { version: 1, providers: [provider], assignments: { 'image-gen': [modelRef] } });
  const env = minimalEnv(workspace);
  const providerConfig = ['[providers.selected]', 'type = ' + JSON.stringify(selected.provider.type)];
  if (selected.provider.base_url) providerConfig.push('base_url = ' + JSON.stringify(selected.provider.base_url));
  if (auth === 'local') {
    assert(selected.provider.api_key, 'Selected local provider has no key');
    env.IRIS_KIMI_LIVE_MODEL_KEY = selected.provider.api_key;
    providerConfig.push('api_key_env = "IRIS_KIMI_LIVE_MODEL_KEY"');
  } else {
    assert.equal(selected.provider.oauth?.storage, 'file');
    assert.equal(selected.provider.oauth?.key, 'oauth/kimi-code');
    // Reuse Kimi's own token store and automatic refresh, without copying tokens.
    fs.symlinkSync(selected.credentials, path.join(home, 'credentials'), 'dir');
    providerConfig.push('oauth = { storage = "file", key = "oauth/kimi-code" }');
  }
  const modelLines = Object.entries(selected.model).filter(([key]) => key !== 'provider')
    .map(([key, value]) => key + ' = ' + JSON.stringify(value));
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'default_model = "selected"', 'telemetry = false', 'auto_session_title = false', 'builtin_product_skills = false',
    ...providerConfig, '[models.selected]', 'provider = "selected"', ...modelLines,
    '[thinking]', ...Object.entries(selected.thinking).map(([key, value]) => key + ' = ' + JSON.stringify(value)),
    '[loop_control]', 'max_steps_per_turn = 8', 'max_attempts_per_step = 1', ''
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  save(path.join(home, 'mcp.json'), { mcpServers: { iris_live: {
    command: process.execPath, args: [self, '--mcp', workspace], toolTimeoutMs: 195000
  } } });
  const agent = path.join(workspace, 'agent.md');
  fs.writeFileSync(agent, '---\nname: iris-live\ndescription: Isolated real image generation trial\ntools: [mcp__iris_live__*]\nsubagents: []\n---\n'
    + 'You are testing real Iris image generation for the user. Use generate_once for their image request. It is bound to the exact user prompt and the preselected media provider. '
    + 'Never retry generation or change provider. After it returns, call inspect_task once to verify the same persistent Task and Artifact. '
    + 'If an image is returned, inspect it if your model supports image input. Report the observed result and Task/Artifact IDs in Chinese. '
    + 'If generation or image reading fails, state the actual failure; never claim success without an image artifact.\n', { mode: 0o600, flag: 'wx' });
  save(path.join(output, 'selected.json'), { auth, alias: selected.alias, providerType: selected.provider.type,
    model: selected.model.model, capabilities: selected.model.capabilities, prompt, mediaModelRef: modelRef, maxImageSubmissions: 1 });
  let result;
  try {
    result = await run(kimi, ['--agent-file', agent, '--skills-dir', path.join(workspace, 'skills'),
      '--output-format', 'stream-json', '-p', prompt], { cwd: workspace, env, logs: path.join(output, 'kimi') });
  } finally {
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    save(path.join(output, 'requests.json'), { imageSubmissions: submissions, requests });
  }
  const operations = fs.existsSync(path.join(workspace, 'operations.jsonl'))
    ? fs.readFileSync(path.join(workspace, 'operations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const report = { auth, alias: selected.alias, model: selected.model.model, prompt,
    process: { status: result.status, signal: result.signal, timedOut: result.timedOut, error: result.spawnError },
    imageSubmissions: submissions, operations, realImageGenerationValidated: operations.some(op => op.outcome === 'succeeded' && op.bytes > 0),
    secondHostAccepted: false };
  save(path.join(output, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
try {
  if (args.includes('--mcp')) await mcp(option('--mcp'));
  else if (args.includes('--live')) await live(option('--output'), option('--auth'), args.includes('--kimi') ? option('--kimi') : 'kimi');
  else console.log('Opt-in REAL model and image calls: node experiments/kimi-code/live.mjs --live --auth <local|oauth> --output <new-absolute-directory>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
