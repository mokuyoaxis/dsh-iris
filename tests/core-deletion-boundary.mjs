import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CORE_COMMANDS } from '../lib/command-service.js';

const read = (relative) => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const client = read('lib/client.js');
const doctor = read('lib/doctor.js');
const roadmap = read('docs/ROADMAP.md');
const migration = read('docs/DSH_CORE_MIGRATION.md');
const headless = read('docs/HEADLESS_CLI.md');

assert(CORE_COMMANDS.includes('core.delete') && CORE_COMMANDS.includes('core.cleanup') && CORE_COMMANDS.includes('core.restore')
  && !CORE_COMMANDS.some(name => /purge/.test(name)),
  '用户授权的 Core CLI 必须开放可恢复删除/清理/恢复，保留永久 purge 的封闭边界');

const galleryStart = client.indexOf('function ArtifactGallery');
const galleryEnd = client.indexOf('function coreCapabilityLabel', galleryStart);
assert(galleryStart >= 0 && galleryEnd > galleryStart, '无法定位统一作品区');
const gallery = client.slice(galleryStart, galleryEnd);
assert(gallery.includes('Core 作品不会删除') && gallery.includes('清空旧版作品')
    && gallery.includes('内容哈希保护') && gallery.includes('删除选中 Core 作品') && gallery.includes('Core 回收区'),
  'DSH 作品区必须区分 Core 可恢复管理与 legacy 永久删除');
const management = read('lib/workbench-management.js');
assert(management.includes("maintainWorkbenchForDsh('core.delete'")
  && management.includes("maintainWorkbenchForDsh('core.restore'")
  && management.includes('confirm_restore !== true') && !management.includes('quarantineCoreFiles'),
  '工作台必须复用 Core Command Service、显式确认恢复，不另写删除实现');

const coreChecksStart = doctor.indexOf('function appendCoreChecks');
const coreChecksEnd = doctor.indexOf('function summarizeChecks', coreChecksStart);
assert(coreChecksStart >= 0 && coreChecksEnd > coreChecksStart, '无法定位 Doctor Core 检查');
const coreChecks = doctor.slice(coreChecksStart, coreChecksEnd);
assert(coreChecks.includes('orphanObjects') && coreChecks.includes('未提交 Manifest')
    && coreChecks.includes('未解析条目'),
  'Doctor 必须只读报告 Core 孤立对象、未提交 Manifest 与未解析条目');
assert(!/(?:rmSync|unlinkSync|rebuildCoreArtifactIndex)/.test(coreChecks),
  'Doctor Core 检查不得删除或修复数据');

for (const [name, source] of [
  ['ROADMAP', roadmap],
  ['DSH_CORE_MIGRATION', migration],
  ['HEADLESS_CLI', headless]
]) {
  assert(source.includes('DSH 工作台') && source.includes('Headless CLI')
      && source.includes('legacy `outputs/`') && source.includes('CLI_MANAGEMENT.md'),
  `${name} 必须说明 DSH 的 legacy 删除边界与开发版 CLI 可恢复删除入口`);
  assert(source.includes('WORKBENCH_ARTIFACTS.md'), `${name} 必须关联工作台可恢复管理说明`);
}

console.log('core deletion boundary tests passed');
