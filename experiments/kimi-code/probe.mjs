/** Opt-in Kimi Code wiring probe. Both model and image providers are local fixtures. */
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
const repo = path.resolve(path.dirname(self), '../..');
const cliFile = path.join(repo, 'bin/dsh-iris.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

async function processResult(command, args, { cwd, env, timeoutMs = 120000 } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error, timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', cause => { error = cause; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const [status, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  clearTimeout(timer);
  return { status, signal, timedOut, stdout, stderr, ...(error ? { error: error.code || error.name } : {}) };
}

async function cli(workspace, args) {
  const result = await processResult(process.execPath, [cliFile, ...args, '--data-root', path.join(workspace, 'core')],
    { cwd: workspace, env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', DSH_HOME: path.join(workspace, 'unused-dsh-home') } });
  assert.equal(result.timedOut, false, 'Iris CLI timed out');
  assert.equal(result.signal, null, 'Iris CLI terminated: ' + result.signal);
  assert.equal(result.status, 0, result.stderr || result.error);
  return JSON.parse(result.stdout);
}

async function operation(workspace, name) {
  assert(path.isAbsolute(workspace), 'workspace must be absolute');
  const fixture = json(path.join(workspace, 'fixture.json'));
  assert.equal(fixture.kind, 'iris-kimi-local-fixture-v1');
  const stateFile = path.join(workspace, 'trial-state.json');
  if (name === 'start') {
    assert(!fs.existsSync(stateFile), 'Trial already started; use resume. Never create a second Run to recover.');
    await cli(workspace, ['flow', 'init']);
    const imported = await cli(workspace, ['artifact', 'import', '--input', JSON.stringify({ image_path: path.join(workspace, 'source.png') })]);
    const created = await cli(workspace, ['flow', 'create', '--provider-config', path.join(workspace, 'providers.json'),
      '--input', JSON.stringify({ source_artifact_id: imported.artifact.id, model_ref: 'trial::edit', prompt: 'Turn the red rectangle green.', n: 1 })]);
    writeJson(stateFile, { runId: created.run.id, taskId: created.run.edit.taskId, sourceId: imported.artifact.id });
    const completed = await cli(workspace, ['flow', 'continue', created.run.id, '--provider-config', path.join(workspace, 'providers.json')]);
    assert.equal(completed.status, 'awaiting_selection');
    assert.equal(completed.task.id, created.run.edit.taskId);
    await cli(workspace, ['flow', 'select', created.run.id, '--input', JSON.stringify({ artifact_id: completed.run.output.artifactId })]);
    await cli(workspace, ['flow', 'export', created.run.id, '--output', path.join(workspace, 'result.png')]);
  } else assert.equal(name, 'resume', 'Unknown operation');
  const state = json(stateFile);
  // A completed Run must remain readable without resolving a provider or submitting again.
  const current = await cli(workspace, ['flow', 'continue', state.runId]);
  assert.equal(current.run.edit.taskId, state.taskId);
  assert.equal(current.task.id, state.taskId);
  assert.equal(current.status, 'selected');
  const summary = { mode: 'local-fixture', operation: name, runId: state.runId, taskId: state.taskId,
    artifactId: current.run.output.artifactId, status: current.status, imagePath: path.join(workspace, 'result.png'),
    imageSha256: hash(fs.readFileSync(path.join(workspace, 'result.png'))) };
  fs.appendFileSync(path.join(workspace, 'operations.jsonl'), JSON.stringify(summary) + '\n', { mode: 0o600 });
  return summary;
}

/** Deliberately small, test-only MCP peer. This is not a production MCP server. */
async function mcpFixture(workspace) {
  assert(path.isAbsolute(workspace));
  assert.equal(json(path.join(workspace, 'fixture.json')).kind, 'iris-kimi-local-fixture-v1');
  writeJson(path.join(workspace, 'mcp-process.json'), { pid: process.pid });
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const tools = [
    { name: 'read_source', description: 'Read this isolated trial source image.', inputSchema: schema },
    { name: 'start', description: 'Run this local Iris fixture once and return its image and persistent identities.', inputSchema: schema },
    { name: 'resume', description: 'Re-read the same Iris Run and Task; never create or submit another.', inputSchema: schema }
  ];
  const image = file => ({ type: 'image', mimeType: 'image/png', data: fs.readFileSync(path.join(workspace, file)).toString('base64') });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'iris-kimi-trial-fixture', version: '0.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call') {
        assert(tools.some(tool => tool.name === request.params?.name), 'Unknown fixture tool');
        const args = request.params.arguments ?? {};
        assert(args !== null && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0,
          'Fixture tools accept no paths, commands, models or other arguments');
        if (request.params.name === 'read_source') result = { content: [image('source.png')] };
        else {
          const summary = await operation(workspace, request.params.name);
          result = { content: [{ type: 'text', text: JSON.stringify(summary) }, ...(request.params.name === 'start' ? [image('result.png')] : [])] };
        }
      } else throw new Error('Unsupported fixture method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32602, message: error.message } }) + '\n');
      else throw error;
    }
  }
}

function minimalEnvironment(workspace) {
  const inherited = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'LD_LIBRARY_PATH'];
  return { ...Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    KIMI_CODE_HOME: path.join(workspace, 'kimi-home'), KIMI_CODE_TRUST_WORKSPACE: '1',
    KIMI_LOOP_MAX_STEPS_PER_TURN: '8', KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '1',
    DSH_HOME: path.join(workspace, 'unused-dsh-home') };
}

async function runProbe(output, kimi) {
  assert(path.isAbsolute(output), '--output must be absolute');
  assert(!fs.existsSync(output), '--output must be a new directory');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const workspace = path.join(output, 'workspace');
  const home = path.join(workspace, 'kimi-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, 'skills'), { mode: 0o700 });
  const source = await sharp({ create: { width: 256, height: 160, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const edited = await sharp({ create: { width: 256, height: 160, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const restricted = await sharp({ create: { width: 256, height: 160, channels: 3, background: '#0000ff' } }).png().toBuffer();
  fs.writeFileSync(path.join(workspace, 'source.png'), source, { mode: 0o600 });
  const forbiddenImage = path.join(output, 'restricted-fixture.png');
  fs.writeFileSync(forbiddenImage, restricted, { mode: 0o600 });
  const forbiddenMarker = path.join(output, 'forbidden-command-ran');
  writeJson(path.join(workspace, 'fixture.json'), { kind: 'iris-kimi-local-fixture-v1', sourceHash: hash(source), resultHash: hash(edited) });
  const sourcePath = path.join(workspace, 'source.png'), resultPath = path.join(workspace, 'result.png');
  const mediaCalls = [], llmCalls = [], failures = [];
  let toolIndex = 0;
  const toolSteps = [
    { name: 'mcp__iris_trial__read_source', args: {} },
    { name: 'mcp__iris_trial__start', args: {} },
    { name: 'mcp__iris_trial__resume', args: {} },
    { name: 'Bash', args: { command: [process.execPath, '-e', 'require("fs").writeFileSync(' + JSON.stringify(forbiddenMarker) + ', "unexpected")'].map(quote).join(' '), cwd: workspace } },
    { name: 'ReadMediaFile', args: { path: forbiddenImage } },
    { name: 'mcp__iris_trial__read_source', args: { path: forbiddenImage } }
  ];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        assert(length <= 4 * 1024 * 1024, 'Probe request too large');
        chunks.push(chunk);
      }
      assert.equal(request.method, 'POST');
      const body = JSON.parse(Buffer.concat(chunks));
      if (request.url === '/media/v1/chat/completions') {
        assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
        assert.equal(body.model, 'edit');
        const image = body.messages[0].content.find(part => part.type === 'image_url').image_url.url;
        assert.equal(hash(Buffer.from(image.split(',')[1], 'base64')), hash(source));
        const state = json(path.join(workspace, 'trial-state.json'));
        mediaCalls.push({ runId: state.runId, taskId: state.taskId });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '![fixture](data:image/png;base64,' + edited.toString('base64') + ')' } }] }));
        return;
      }
      assert.equal(request.url, '/llm/v1/chat/completions');
      const tools = body.tools.map(tool => tool.function.name);
      assert.deepEqual([...tools].sort(), ['mcp__iris_trial__read_source', 'mcp__iris_trial__resume', 'mcp__iris_trial__start']);
      const images = [];
      for (const message of body.messages) if (Array.isArray(message.content)) {
        for (const part of message.content) if (part.type === 'image_url') {
          const bytes = Buffer.from(part.image_url.url.split(',')[1], 'base64');
          images.push({ sha256: hash(bytes), ...await sharp(bytes).metadata().then(({ width, height }) => ({ width, height })) });
        }
      }
      llmCalls.push({ step: toolIndex, tools, images });
      assert(toolIndex <= toolSteps.length, 'Unexpected extra model request');
      const step = toolSteps[toolIndex++];
      const tool = step && { id: 'probe_call_' + toolIndex, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } };
      const finish = tool ? 'tool_calls' : 'stop';
      const content = tool ? null : 'IRIS_KIMI_FIXTURE_COMPLETE: tool and image transport only; no real model or image generation.';
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : { role: 'assistant', content }, finish_reason: null }] }) + '\n\n');
        response.end('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'probe', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content, ...(tool ? { tool_calls: [tool] } : {}) }, finish_reason: finish }] }));
      }
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  writeJson(path.join(workspace, 'providers.json'), { providers: [{ id: 'trial', baseUrl: base + '/media/v1', apiKey: 'local-fixture-only',
    mediaProtocol: 'openai-images', models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' }] }],
    assignments: { 'image-gen': ['trial::edit'] } });
  const config = [
    'default_model = "probe"', 'telemetry = false', 'auto_session_title = false', 'builtin_product_skills = false',
    '[providers.probe]', 'type = "openai"', 'api_key = "local-fixture-only"', 'base_url = ' + JSON.stringify(base + '/llm/v1'),
    '[models.probe]', 'provider = "probe"', 'model = "iris-kimi-fixture"', 'max_context_size = 32768', 'capabilities = ["image_in", "tool_use"]',
    '[thinking]', 'enabled = false', '[loop_control]', 'max_steps_per_turn = 8', 'max_attempts_per_step = 1',
    '[background]', 'bash_auto_background_on_timeout = false', ''
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 });
  writeJson(path.join(home, 'mcp.json'), { mcpServers: { iris_trial: {
    command: process.execPath, args: [self, '--mcp-fixture', workspace], toolTimeoutMs: 45000
  } } });
  const agentFile = path.join(workspace, 'trial-agent.md');
  fs.writeFileSync(agentFile, '---\nname: iris-trial\ndescription: Isolated Iris CLI wiring trial\ntools: [mcp__iris_trial__*]\nsubagents: []\n---\n'
    + 'This is a local fixture transport test, not real model or image-generation validation. Use only the three Iris fixture tools, which accept no arguments. Never create a second Run to recover.\n', { mode: 0o600 });
  const prompt = ['Test Iris through its existing CLI. This uses fixed local image and LLM fixtures, not paid services.',
    'Read the source with read_source, call start and inspect its returned image, then call resume.',
    'Report only the observed Run/Task identities and that this is fixture validation.'].join('\n');
  let result;
  let report;
  try {
    const version = await processResult(kimi, ['--version'], { cwd: workspace, env: minimalEnvironment(workspace), timeoutMs: 25000 });
    assert.equal(version.status, 0, version.stderr || version.error);
    result = await processResult(kimi, ['--agent-file', agentFile, '--skills-dir', path.join(workspace, 'skills'),
      '--output-format', 'stream-json', '-p', prompt], { cwd: workspace, env: minimalEnvironment(workspace) });
    fs.writeFileSync(path.join(output, 'kimi.stdout.jsonl'), result.stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'kimi.stderr.log'), result.stderr, { mode: 0o600 });
    writeJson(path.join(output, 'process-result.json'), { status: result.status, signal: result.signal, timedOut: result.timedOut, error: result.error });
    assert.equal(result.status, 0, result.stderr || result.error);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.deepEqual(failures, []);
    assert.equal(llmCalls.length, 7);
    assert.equal(mediaCalls.length, 1, 'Resume must never resubmit');
    assert(llmCalls[1].images.some(image => image.sha256 === hash(source)), 'Kimi must send source bytes back to the model');
    assert(llmCalls[2].images.some(image => image.sha256 === hash(edited)), 'Kimi must send result bytes back to the model');
    assert(!llmCalls.some(call => call.images.some(image => image.sha256 === hash(restricted))), 'Restricted image must never reach the model');
    assert(!fs.existsSync(forbiddenMarker), 'Only the two explicitly allowed Bash commands may execute');
    const operations = fs.readFileSync(path.join(workspace, 'operations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(operations.map(operation => operation.operation), ['start', 'resume']);
    for (const key of ['runId', 'taskId', 'artifactId', 'imageSha256']) assert.equal(operations[0][key], operations[1][key]);
    assert.equal(operations[0].imageSha256, hash(edited));
    report = { status: 'passed', mode: 'local-fixtures', kimiVersion: version.stdout.trim(),
      transport: 'test-only stdio MCP to existing Iris CLI',
      modelRequests: llmCalls.length, imageSubmissions: mediaCalls.length, operations,
      sourceImageReachedModel: true, resultImageReachedModel: true, stableRunAndTask: true,
      forbiddenCommandBlocked: true, forbiddenImageBlocked: true,
      configurationRulesGateValidated: false,
      realModelValidated: false, realImageGenerationValidated: false, secondHostAccepted: false };
  } finally {
    writeJson(path.join(output, 'fixture-requests.json'), { llmCalls, mediaCalls, failures });
    if (report) writeJson(path.join(output, 'report.json'), report);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), ...report }, null, 2));
}

const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
try {
  if (option('--operation')) console.log(JSON.stringify(await operation(option('--workspace'), option('--operation'))));
  else if (option('--mcp-fixture')) await mcpFixture(option('--mcp-fixture'));
  else if (args.includes('--help')) console.log('node experiments/kimi-code/probe.mjs [--output <new-absolute-directory>] [--kimi <executable>]\nRuns actual Kimi Code with local scripted LLM and image fixtures. No personal credentials or model services.');
  else await runProbe(option('--output') || path.join(os.tmpdir(), 'iris-kimi-trial-' + crypto.randomUUID()), option('--kimi') || 'kimi');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
