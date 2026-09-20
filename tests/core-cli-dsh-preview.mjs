import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { root, cleanup } = useTempDshHome('iris-core-cli-dsh-preview');
const { dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { serveApi } = await import('../lib/api.js');
const input = path.join(root, 'cli-input.png');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function response() {
  return {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, headers: {}, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; }
  };
}

try {
  await sharp({ create: { width: 12, height: 9, channels: 4, background: '#6157d9' } }).png().toFile(input);
  const run = spawnSync(process.execPath, ['bin/dsh-iris.js', 'run', 'crop',
    '--data-root', dshCoreDataRoot(), '--input', JSON.stringify({
      image_path: input, left: 1, top: 1, width: 8, height: 6
    })], { cwd: repo, env: { ...process.env, DSH_HOME: root }, encoding: 'utf8', shell: false });
  assert(run.status === 0, 'CLI 必须能写入 DSH Adapter 选定的 Core 数据根', run.stderr);
  const artifact = JSON.parse(run.stdout).artifact;
  assert(/^artifact_[a-f0-9]{24}$/.test(artifact?.id), 'CLI 必须返回 Core Artifact', artifact);

  const snapshotResponse = response();
  await serveApi({ method: 'GET', url: '/iris/api/core/snapshot' }, snapshotResponse);
  const snapshot = JSON.parse(String(snapshotResponse.body));
  assert(snapshotResponse.status === 200 && snapshot.artifacts.total === 1
      && snapshot.artifacts.recent[0].id === artifact.id,
  'DSH 工作台必须读取 CLI 写入的同一 Artifact', snapshot);

  const store = path.join(dshCoreDataRoot(), 'artifact-store', 'v0');
  const index = path.join(store, 'index.json');
  const manifest = path.join(store, 'manifests', artifact.id + '.json');
  const indexBefore = fs.readFileSync(index, 'utf8');
  const manifestBefore = fs.readFileSync(manifest, 'utf8');
  const url = '/iris/api/core/artifact/' + artifact.id + '/media';
  const mediaResponse = response();
  await serveApi({ method: 'GET', url }, mediaResponse);
  assert(mediaResponse.status === 200 && mediaResponse.headers['Content-Type'] === 'image/png'
      && mediaResponse.headers['Cross-Origin-Resource-Policy'] === 'same-origin'
      && mediaResponse.headers['Referrer-Policy'] === 'no-referrer'
      && Buffer.isBuffer(mediaResponse.body) && mediaResponse.body.length === artifact.size,
  'DSH 同源路由必须返回 CLI Core 图片字节', {
    status: mediaResponse.status, headers: mediaResponse.headers, bytes: mediaResponse.body?.length
  });
  const dimensions = await sharp(mediaResponse.body).metadata();
  assert(dimensions.width === 8 && dimensions.height === 6, '预览字节必须是同一张 CLI 产物', dimensions);

  const headResponse = response();
  await serveApi({ method: 'HEAD', url }, headResponse);
  assert(headResponse.status === 200 && headResponse.body === undefined
      && Number(headResponse.headers['Content-Length']) === artifact.size,
  'HEAD 必须只返回 Core 媒体元数据', headResponse);
  assert(fs.readFileSync(index, 'utf8') === indexBefore && fs.readFileSync(manifest, 'utf8') === manifestBefore,
    '反复预览不得修改 Core Index/Manifest');

  const missingResponse = response();
  await serveApi({ method: 'GET', url: '/iris/api/core/artifact/artifact_000000000000000000000000/media' }, missingResponse);
  assert(missingResponse.status === 404 && String(missingResponse.body) === '{"error":"not found"}'
      && !String(missingResponse.body).includes(dshCoreDataRoot()),
  '未授权或不存在的 Core Artifact 必须统一返回无路径 404', missingResponse);

  const tokenizedResponse = response();
  await serveApi({ method: 'GET', url: '/iris/api/core/artifact/' + artifact.id
    + '/0123456789abcdef0123456789abcdef/media' }, tokenizedResponse);
  assert(tokenizedResponse.status === 404,
    '路径 B 必须诚实保持无独立 token 的 Core 路由，不接受伪 token 路径', tokenizedResponse);

  const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert(clientSource.includes("'/iris/api/core/artifact/' + encodeURIComponent(artifact.id) + '/media'")
      && clientSource.includes('galleryItems = coreItems.concat(items)')
      && clientSource.includes("artifact.kind !== 'host-input'"),
  '工作台必须把可展示 Core 图片合入作品区，并排除原始输入 Artifact');
  const securityDoc = fs.readFileSync(new URL('../docs/SECURITY.md', import.meta.url), 'utf8');
  const migrationDoc = fs.readFileSync(new URL('../docs/DSH_CORE_MIGRATION.md', import.meta.url), 'utf8');
  assert(securityDoc.includes('Core 媒体路由') && securityDoc.includes('没有独立 token')
      && securityDoc.includes('IRIS_TRUSTED_HOSTS') && securityDoc.includes('不是身份认证')
      && migrationDoc.includes('Artifact ID 持有者'),
  '公开安全文档必须如实冻结路径 B 的持有者边界，不能再笼统宣称所有媒体都有 token');

  console.log('core CLI -> DSH read-only preview and media boundary tests passed');
} finally {
  cleanup();
}
