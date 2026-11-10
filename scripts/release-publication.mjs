import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { releaseMetadata } from './release-metadata.mjs';

export const MANIFEST_ASSET = 'iris-release-package.json';
export const INTENT_ASSET = 'npm-upload-intent.json';
export const ACCEPTED_ASSET = 'npm-upload-accepted.json';
const FIELDS = ['schemaVersion', 'name', 'version', 'distTag', 'gitTag', 'commit', 'archive', 'size', 'sha256', 'integrity'];
export class ReleasePublicationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ReleasePublicationError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new ReleasePublicationError(code, message, details); };
const digest = (bytes, format) => createHash(format).update(bytes).digest(format === 'sha512' ? 'base64' : 'hex');
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function parseJson(text, code) {
  try { return JSON.parse(text); }
  catch { fail(code, '外部响应不是有效JSON'); }
}
export function checkedManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(value, key))
      || value.schemaVersion !== 1 || typeof value.name !== 'string'
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value.name)
      || typeof value.version !== 'string' || typeof value.gitTag !== 'string'
      || typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)
      || typeof value.archive !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(value.archive)
      || !Number.isSafeInteger(value.size) || value.size <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)) {
    fail('IRIS_RELEASE_MANIFEST_INVALID', '发行归档清单未知或损坏');
  }
  const metadata = releaseMetadata(value.version, value.gitTag);
  if (value.distTag !== metadata.npmTag) fail('IRIS_RELEASE_MANIFEST_INVALID', '发行渠道与版本不匹配');
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, value[key]])));
}
export function createReleaseManifest({ archive, packageJson, tag, commit }) {
  const bytes = fs.readFileSync(archive), metadata = releaseMetadata(packageJson.version, tag);
  return checkedManifest({ schemaVersion: 1, name: packageJson.name, version: packageJson.version,
    distTag: metadata.npmTag, gitTag: tag, commit, archive: path.basename(archive), size: bytes.length,
    sha256: digest(bytes, 'sha256'), integrity: 'sha512-' + digest(bytes, 'sha512') });
}
export function runReleaseCommand(command, args, { timeoutMs = 60000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true,
    timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '',
    errorCode: result.error?.code };
}
function npmCode(result) {
  let value;
  try { value = JSON.parse(result.stdout)?.error?.code; } catch { /* npm can report errors on stderr only. */ }
  const known = /\b(E401|E403|E404|E409|E500|E502|E503|E504|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/;
  return known.exec(String(value || result.stderr))?.[1] || result.errorCode || null;
}
function registryResult(result) {
  if (result.status === 0 && !result.errorCode && !result.signal) return parseJson(result.stdout, 'IRIS_RELEASE_REGISTRY_RESPONSE_INVALID');
  const code = npmCode(result);
  if (code === 'E404') return null;
  if (['E401', 'E403'].includes(code)) fail('IRIS_RELEASE_REGISTRY_AUTH', '注册表拒绝访问，请核对认证与权限；不会当作尚未发布', { npmCode: code });
  if (['E500', 'E502', 'E503', 'E504', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) {
    fail('IRIS_RELEASE_REGISTRY_NETWORK', '注册表网络或服务暂不可用', { npmCode: code });
  }
  fail('IRIS_RELEASE_REGISTRY_FAILED', '注册表命令失败', { npmCode: code, exitCode: result.status, signal: result.signal });
}
const viewArgs = ['--json', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000', '--registry=https://registry.npmjs.org/'];
function registryPackage(manifest, execute, timeoutMs = 20000) {
  const value = registryResult(execute('npm', ['view', manifest.name + '@' + manifest.version, ...viewArgs], { timeoutMs }));
  if (value !== null && (value.name !== manifest.name || value.version !== manifest.version || value.dist?.integrity !== manifest.integrity)) {
    fail('IRIS_RELEASE_PACKAGE_MISMATCH', '注册表版本或归档摘要与本次候选不符，不上传或覆盖', { version: manifest.version });
  }
  return value;
}
function registryChannel(manifest, execute, timeoutMs) {
  const value = registryResult(execute('npm', ['view', manifest.name, 'dist-tags.' + manifest.distTag, ...viewArgs], { timeoutMs }));
  if (value !== null && typeof value !== 'string') fail('IRIS_RELEASE_REGISTRY_RESPONSE_INVALID', '注册表渠道响应不是版本字符串');
  return value;
}
function sameManifest(value, expected) {
  const actual = checkedManifest(value);
  if (!FIELDS.every(key => actual[key] === expected[key])) fail('IRIS_RELEASE_PACKAGE_MISMATCH', '已有发行清单或回执绑定了另一归档/提交，保留原记录');
}
function githubContext({ repo, workDirectory, execute = runReleaseCommand }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new TypeError('需要准确GitHub OWNER/REPO');
  const directory = fs.mkdtempSync(path.join(workDirectory || os.tmpdir(), 'iris-release-'));
  function gh(args) {
    const result = execute('gh', [...args, '--repo', repo], { timeoutMs: 60000 });
    if (result.status !== 0 || result.errorCode || result.signal) {
      fail('IRIS_RELEASE_GITHUB_FAILED', 'GitHub发行命令失败，保留已有附件', { operation: args.slice(0, 2).join(' '), exitCode: result.status, signal: result.signal });
    }
    return result.stdout;
  }
  return { directory, execute, gh };
}
function releaseView(manifest, context) {
  const value = parseJson(context.gh(['release', 'view', manifest.gitTag, '--json', 'tagName,isDraft,isPrerelease,assets']), 'IRIS_RELEASE_GITHUB_RESPONSE_INVALID');
  if (value?.tagName !== manifest.gitTag || typeof value.isDraft !== 'boolean'
      || value.isPrerelease !== (manifest.distTag !== 'latest') || !Array.isArray(value.assets)
      || value.assets.some(asset => typeof asset.name !== 'string')) fail('IRIS_RELEASE_GITHUB_RESPONSE_INVALID', 'GitHub发行身份或附件列表与候选不符');
  return value;
}
function downloadAsset(manifest, name, context) {
  const target = path.join(fs.mkdtempSync(path.join(context.directory, 'read-')), name);
  context.gh(['release', 'download', manifest.gitTag, '--pattern', name, '--output', target]);
  return fs.readFileSync(target);
}
function receipt(manifest, release, name, kind, context) {
  if (!release.assets.some(asset => asset.name === name)) return null;
  const value = parseJson(downloadAsset(manifest, name, context).toString('utf8'), 'IRIS_RELEASE_RECEIPT_INVALID');
  if (value?.schemaVersion !== 1 || value.kind !== kind || typeof value.createdAt !== 'string'
      || !(kind === 'intent' ? value.evidence === 'intent' : ['npm-publish', 'registry'].includes(value.evidence))) fail('IRIS_RELEASE_RECEIPT_INVALID', '已有npm回执未知或损坏');
  sameManifest(value.manifest, manifest);
  return value;
}
function uploadReceipt(manifest, kind, evidence, context) {
  const name = kind === 'intent' ? INTENT_ASSET : ACCEPTED_ASSET;
  const file = path.join(context.directory, name);
  writeJson(file, { schemaVersion: 1, kind, evidence, createdAt: new Date().toISOString(), manifest });
  context.gh(['release', 'upload', manifest.gitTag, file]);
}
function finalize(manifest, release, context) {
  if (release.isDraft) context.gh(['release', 'edit', manifest.gitTag, '--draft=false',
    manifest.distTag === 'latest' ? '--latest=true' : '--latest=false']);
}
export function publishRelease({ manifest: input, archive, notes, ...options }) {
  const manifest = checkedManifest(input), bytes = fs.readFileSync(archive);
  if (path.basename(archive) !== manifest.archive || bytes.length !== manifest.size
      || digest(bytes, 'sha256') !== manifest.sha256 || 'sha512-' + digest(bytes, 'sha512') !== manifest.integrity) {
    fail('IRIS_RELEASE_PACKAGE_MISMATCH', '本地归档与发行清单不符');
  }
  const context = githubContext(options);
  const listed = parseJson(context.gh(['release', 'list', '--limit', '1000', '--json', 'tagName']), 'IRIS_RELEASE_GITHUB_RESPONSE_INVALID');
  if (!Array.isArray(listed) || listed.some(value => typeof value.tagName !== 'string')) fail('IRIS_RELEASE_GITHUB_RESPONSE_INVALID', 'GitHub发行列表无效');
  if (!listed.some(value => value.tagName === manifest.gitTag)) {
    const file = path.join(context.directory, MANIFEST_ASSET); writeJson(file, manifest);
    context.gh(['release', 'create', manifest.gitTag, '--verify-tag', '--draft', '--title', 'Iris ' + manifest.gitTag, '--notes-file', notes,
      ...(manifest.distTag === 'latest' ? [] : ['--prerelease', '--latest=false']), archive, file]);
  }
  const release = releaseView(manifest, context);
  if (!release.assets.some(asset => asset.name === MANIFEST_ASSET) || !release.assets.some(asset => asset.name === manifest.archive)) {
    fail('IRIS_RELEASE_PACKAGE_MISMATCH', '已有发行缺少候选清单或归档，不覆盖原附件');
  }
  sameManifest(parseJson(downloadAsset(manifest, MANIFEST_ASSET, context).toString('utf8'), 'IRIS_RELEASE_MANIFEST_INVALID'), manifest);
  const remoteArchive = downloadAsset(manifest, manifest.archive, context);
  if (remoteArchive.length !== manifest.size || digest(remoteArchive, 'sha256') !== manifest.sha256) fail('IRIS_RELEASE_PACKAGE_MISMATCH', '已有GitHub附件字节与候选不符');
  const accepted = receipt(manifest, release, ACCEPTED_ASSET, 'accepted', context);
  const intent = receipt(manifest, release, INTENT_ASSET, 'intent', context);
  const present = registryPackage(manifest, context.execute);
  if (present) {
    if (release.isDraft && !accepted) uploadReceipt(manifest, 'accepted', 'registry', context);
    finalize(manifest, release, context);
    return { state: 'already_published', manifest };
  }
  if (accepted || intent) {
    if (!accepted) fail('IRIS_RELEASE_SUBMISSION_UNKNOWN', '已有上传意图但尚无接受回执，注册表也不可见；保留草稿与原记录，稍后核对，禁止自动再次上传', { manifest });
    finalize(manifest, release, context);
    return { state: 'accepted_pending_visibility', manifest };
  }
  if (!release.isDraft) fail('IRIS_RELEASE_DRAFT_REQUIRED', '已有公开发行没有上传回执且注册表不可见，需要人工核对，不自动上传');
  uploadReceipt(manifest, 'intent', 'intent', context);
  const result = context.execute('npm', ['publish', archive, '--access', 'public', '--provenance', '--tag', manifest.distTag,
    '--registry=https://registry.npmjs.org/'], { timeoutMs: 120000 });
  if (result.status !== 0 || result.errorCode || result.signal) {
    fail('IRIS_RELEASE_PUBLISH_FAILED', 'npm上传未正常结束；意图已保存，重跑将先核对结果，不盲目再次上传',
      { npmCode: npmCode(result), exitCode: result.status, signal: result.signal });
  }
  uploadReceipt(manifest, 'accepted', 'npm-publish', context);
  finalize(manifest, release, context);
  return { state: 'accepted_pending_visibility', manifest };
}
export async function verifyPublication(input, { execute = runReleaseCommand, timeoutMs = 600000, intervalMs = 10000,
  now = () => performance.now(), sleep = delay, onPending = () => {} } = {}) {
  const manifest = checkedManifest(input);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000
      || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 10000) throw new TypeError('确认预算或间隔无效');
  const started = now(), deadline = started + timeoutMs;
  let attempts = 0, reason = 'version_not_visible';
  while (now() < deadline) {
    attempts++;
    try {
      const value = registryPackage(manifest, execute, Math.min(20000, Math.max(1, Math.floor(deadline - now()))));
      if (value && now() < deadline) {
        const channel = registryChannel(manifest, execute, Math.min(20000, Math.max(1, Math.floor(deadline - now()))));
        if (channel === manifest.version && now() <= deadline) return { state: 'confirmed', manifest, attempts, elapsedMs: Math.round(now() - started) };
        reason = 'channel_not_visible';
      } else reason = 'version_not_visible';
    } catch (error) {
      if (error.code !== 'IRIS_RELEASE_REGISTRY_NETWORK') throw error;
      reason = error.details.npmCode;
    }
    onPending({ attempts, reason, remainingMs: Math.max(0, Math.round(deadline - now())) });
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  fail('IRIS_RELEASE_CONFIRM_TIMEOUT', '注册表未在预算内确认版本、归档摘要与渠道；可单独重跑只读确认任务',
    { attempts, elapsedMs: Math.round(now() - started), reason, manifest });
}
function cliArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith('--') || values[index + 1] === undefined || Object.hasOwn(parsed, values[index])) throw new TypeError('发行脚本参数无效或重复');
    parsed[values[index]] = values[index + 1];
  }
  return parsed;
}
async function main() {
  const [mode, ...values] = process.argv.slice(2), args = cliArgs(values), output = args['--output'];
  if (!output) throw new TypeError('需要新的--output文件');
  let result;
  try {
    if (mode === 'prepare') {
      if (Object.keys(args).sort().join(',') !== '--archive,--commit,--output,--tag') throw new TypeError('prepare参数无效');
      result = createReleaseManifest({ archive: args['--archive'], packageJson: JSON.parse(fs.readFileSync('package.json', 'utf8')),
        tag: args['--tag'], commit: args['--commit'] });
      writeJson(output, result); console.log(JSON.stringify(result)); return;
    }
    if (mode === 'publish') {
      if (Object.keys(args).sort().join(',') !== '--archive,--manifest,--notes,--output,--repo') throw new TypeError('publish参数无效');
      result = publishRelease({ manifest: parseJson(fs.readFileSync(args['--manifest'], 'utf8'), 'IRIS_RELEASE_MANIFEST_INVALID'),
        archive: args['--archive'], notes: args['--notes'], repo: args['--repo'], workDirectory: path.dirname(output) });
    } else if (mode === 'verify') {
      if (Object.keys(args).sort().join(',') !== '--manifest-json,--output') throw new TypeError('verify参数无效');
      result = await verifyPublication(parseJson(args['--manifest-json'], 'IRIS_RELEASE_MANIFEST_INVALID'),
        { onPending: state => console.log('PUBLICATION_PENDING ' + JSON.stringify(state)) });
    } else throw new TypeError('未知发行脚本模式');
    writeJson(output, { status: 'passed', ...result }); console.log(JSON.stringify({ status: 'passed', state: result.state }));
  } catch (error) {
    const record = { status: 'failed', code: error.code || error.name, message: error.message,
      ...(error instanceof ReleasePublicationError ? { details: error.details } : {}) };
    writeJson(output, record);
    console.error(JSON.stringify(record));
    if (!(error instanceof ReleasePublicationError)) console.error(error.stack);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
