import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-dsh-core-adapter-v0');
const { cropForDsh, dshCoreDataRoot } = await import('../lib/dsh-core-adapter.js');
const { listCoreArtifacts, readCoreArtifactBytes } = await import('../lib/core-artifacts.js');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

try {
  const inputBytes = await sharp({
    create: { width: 12, height: 10, channels: 4, background: '#5d63d8' }
  }).png().toBuffer();
  const inputPath = path.join(root, 'source.png');
  fs.writeFileSync(inputPath, inputBytes);

  const fromPath = await cropForDsh({ imagePath: inputPath, left: 1, top: 2, width: 6, height: 5 });
  assert(fromPath.width === 6 && fromPath.height === 5 && fromPath.mediaType === 'image/png',
    'DSH 路径输入必须经 Command 返回中性裁剪结果', fromPath);
  assert(fromPath.artifact.relations.length === 0,
    '宿主路径不应被写入 Manifest，也不能伪造来源关系', fromPath.artifact);

  const fromAttachment = await cropForDsh({
    bytes: inputBytes, mediaType: 'image/png', left: 2, top: 1, width: 4, height: 3
  });
  const metadata = await sharp(fromAttachment.bytes).metadata();
  assert(metadata.width === 4 && metadata.height === 3,
    'DSH attachment 投影必须返回可保存的真实媒体字节', metadata);
  assert(fromAttachment.artifact.relations.length === 1
      && fromAttachment.artifact.relations[0].type === 'derived-from',
    'attachment 输入与裁剪输出必须保留 derived-from 关系', fromAttachment.artifact);

  const sourceId = fromAttachment.artifact.relations[0].artifactId;
  const source = readCoreArtifactBytes(dshCoreDataRoot(), sourceId);
  assert(source.artifact.kind === 'host-input' && source.bytes.equals(inputBytes),
    '宿主输入必须成为可校验、可追溯且不暴露路径的 Artifact', source.artifact);

  const listed = listCoreArtifacts(dshCoreDataRoot());
  assert(listed.total === 3,
    '路径裁剪写一个输出，attachment 裁剪写输入与输出，共三个 Artifact', listed);
  assert(!fs.existsSync(path.join(dshCoreDataRoot(), '.iris-runtime-writer-v0')),
    '单次 DSH 操作完成后必须释放 writer 租约');

  // 同进程并发由 Adapter 排队，不能因瞬时 lease 竞争随机失败。
  const concurrent = await Promise.all([
    cropForDsh({ imagePath: inputPath, left: 0, top: 0, width: 2, height: 2 }),
    cropForDsh({ imagePath: inputPath, left: 2, top: 2, width: 2, height: 2 })
  ]);
  assert(concurrent.every((item) => item.width === 2 && item.height === 2),
    'DSH Adapter 必须在进程内串行化 Core writer 操作');
  assert(!fs.existsSync(path.join(dshCoreDataRoot(), '.iris-runtime-writer-v0')),
    '并发队列完成后也必须释放 writer 租约');

  console.log('ALL OK —— DSH crop 经 Command/Manifest 投影字节、关系边与短租约，并发操作可排队');
} finally {
  cleanup();
}
