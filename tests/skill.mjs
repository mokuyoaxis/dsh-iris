/**
 * iris-verify-ui repository-level DSH Skill structure and workflow guards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillPath = path.join(root, '.dsh', 'skills', 'iris-verify-ui', 'SKILL.md');
const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
};

assert(fs.existsSync(skillPath), 'missing .dsh/skills/iris-verify-ui/SKILL.md');
// 归一化换行符：Windows 检出可能带 CRLF，frontmatter 正则与行数统计按 LF 处理。
const src = fs.readFileSync(skillPath, 'utf8').replaceAll('\r\n', '\n');
const frontmatter = src.match(/^---\n([\s\S]*?)\n---\n/);
assert(frontmatter, 'SKILL.md must have valid YAML frontmatter');
assert(/^name:\s*iris-verify-ui$/m.test(frontmatter[1]), 'Skill name must be iris-verify-ui');
assert(/^description:\s*["']?\S.+$/m.test(frontmatter[1]), 'Skill description must not be empty');
assert(frontmatter[1].includes('用于对照参考图检查界面'), 'description must retain Chinese trigger terms');
assert(path.basename(path.dirname(skillPath)) === 'iris-verify-ui', 'directory name must match the Skill name');
assert(!/TODO|\[TODO/.test(src), 'SKILL.md must not contain scaffold TODOs');
assert(src.split('\n').length <= 180, 'SKILL.md must stay concise at 180 lines or fewer');

for (const tool of [
  'iris_html_screenshot',
  'iris_look_at_image',
  'iris_relook_attachment',
  'iris_pixel_diff',
  'iris_locate',
  'iris_crop'
]) {
  assert(src.includes('`' + tool + '`'), 'workflow is missing tool ' + tool);
}

for (const contract of [
  'Each vision call sees only one image',
  'If dimensions differ, recapture before comparing',
  'longest side exceeds 1024',
  'Run at most 3 modify-and-recheck rounds',
  'Do not declare success from visual impression alone',
  '**Pass**',
  '**Partial pass**',
  '**Indeterminate**'
]) {
  assert(src.includes(contract), 'workflow is missing contract: ' + contract);
}

assert(src.includes('is not concurrency-safe'), 'HTML screenshots must be serialized');
assert(src.includes('cannot navigate an arbitrary URL'), 'HTML screenshot URL limitation must be explicit');
assert(src.includes('do not use this skill'), 'single media operations must not trigger UI verification');

console.log('ALL OK —— iris-verify-ui frontmatter、双语触发、6 工具链、证据纪律和有界复验约束全部通过');
