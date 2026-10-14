/** Execute the shared Skill's Core CLI examples; no model or provider requests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { FAKE_WAV } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-skill-handoff');
const dataRoot = path.join(root, 'core');
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const source = fs.readFileSync(new URL('../.dsh/skills/iris-use/references/media-contract.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const fence = String.fromCharCode(96).repeat(3);
const examples = [...source.matchAll(new RegExp(fence + 'bash\\n([\\s\\S]*?)\\n' + fence, 'g'))].map(match => match[1]);
const inputFor = (command, replacements) => {
  const example = examples.flatMap(text => text.split('\n\n')).find(text => text.trim().startsWith('dsh-iris ' + command));
  assert(example, 'Missing documented command: ' + command);
  const match = example.match(/--input '([^']+)'/);
  assert(match, 'Missing JSON input: ' + command);
  let input = match[1];
  for (const [placeholder, id] of Object.entries(replacements)) input = input.replaceAll(placeholder, id);
  return JSON.parse(input);
};
const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
runtime.start();
try {
  const bytes = await sharp({ create: { width: 250, height: 150, channels: 3, background: '#5165cf' } }).png().toBuffer();
  const originals = await runtime.run('execute', ({ dataRoot }) => [
    createCoreArtifact(dataRoot, { bytes, mediaType: 'image/png', kind: 'original', metadata: { width: 250, height: 150 } }),
    createCoreArtifact(dataRoot, { bytes, mediaType: 'image/png', kind: 'original', metadata: { width: 250, height: 150 } }),
    createCoreArtifact(dataRoot, { bytes: FAKE_WAV, mediaType: 'audio/wav', kind: 'generated-audio' })
  ]);
  await runtime.dispose();

  const cropped = run(['run', 'crop', '--data-root', dataRoot, '--input',
    JSON.stringify(inputFor('run crop', { artifact_ID: originals[0].id }))]);
  assert.equal(cropped.artifact.metadata.width, 200);
  assert.equal(cropped.artifact.metadata.height, 100);
  assert.deepEqual(cropped.artifact.relations, [{ type: 'derived-from', artifactId: originals[0].id }]);

  const diff = run(['media', 'diff', '--data-root', dataRoot, '--input',
    JSON.stringify(inputFor('media diff', { artifact_A: originals[0].id, artifact_B: originals[1].id }))]);
  assert.equal(diff.metrics.ratio, 0);
  assert.equal(diff.artifact.kind, 'pixel-diff');

  assert(examples.some(text => text.includes('artifact export')));
  const audioPath = path.join(root, 'narration.wav');
  run(['artifact', 'export', originals[2].id, '--data-root', dataRoot, '--output', audioPath]);
  assert.deepEqual(fs.readFileSync(audioPath), FAKE_WAV, '导出保持已有音频字节');
  assert.deepEqual(readCoreArtifactBytes(dataRoot, originals[0].id).bytes, bytes, '原图保持');
  assert.equal(listCoreTasks(dataRoot).tasks.length, 0, '本地裁剪/比较/导出不创建生成任务');
  assert.equal(fs.existsSync(path.join(root, 'iris')), false, '显式Core CLI不初始化宿主配置');
  console.log('ALL OK —— Skill 文档的 Core ID 裁剪/比较/音频导出示例跨进程执行，原素材不变');
} finally {
  await runtime.dispose();
  cleanup();
}
