/**
 * iris-compose-media repository-level DSH Skill structure and workflow guards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillPath = path.join(root, '.dsh', 'skills', 'iris-compose-media', 'SKILL.md');
const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
};

assert(fs.existsSync(skillPath), 'missing .dsh/skills/iris-compose-media/SKILL.md');
// 归一化换行符：Windows 检出可能带 CRLF，frontmatter 正则与行数统计按 LF 处理。
const src = fs.readFileSync(skillPath, 'utf8').replaceAll('\r\n', '\n');
const frontmatter = src.match(/^---\n([\s\S]*?)\n---\n/);
assert(frontmatter, 'SKILL.md must have valid YAML frontmatter');
assert(/^name:\s*iris-compose-media$/m.test(frontmatter[1]), 'Skill name must be iris-compose-media');
assert(/^description:\s*["']?\S.+$/m.test(frontmatter[1]), 'Skill description must not be empty');
assert(frontmatter[1].includes('用于看图后绘图'), 'description must retain Chinese trigger terms');
assert(path.basename(path.dirname(skillPath)) === 'iris-compose-media', 'directory name must match the Skill name');
assert(!/TODO|\[TODO/.test(src), 'SKILL.md must not contain scaffold TODOs');
assert(src.split('\n').length <= 180, 'SKILL.md must stay concise at 180 lines or fewer');

for (const tool of [
  'iris_draw_image',
  'iris_generate_video',
  'iris_speak_text',
  'iris_transcribe_audio',
  'iris_task_status',
  'iris_look_at_image',
  'iris_relook_attachment',
  'iris_long_ocr',
  'iris_video_frames',
  'iris_media_summarize'
]) {
  assert(src.includes('`' + tool + '`'), 'workflow is missing tool ' + tool);
}

for (const contract of [
  'two or more dependent Iris operations',
  'one generation attempt per requested artifact',
  'at most 2 generation attempts per artifact',
  'providerId::modelId',
  'never resubmit automatically',
  'smaller than 15 MB',
  'shorter than 20 seconds',
  'Do not pass t2v/i2v-only',
  'Do not also call',
  'Never describe a queued or running task as complete'
]) {
  assert(src.includes(contract), 'workflow is missing contract: ' + contract);
}

assert(src.includes('browser-local path'), 'host and browser path boundary must be explicit');
assert(src.includes('Do not pass an ordinary session attachment'), 'video first-frame attachment boundary must be explicit');
assert(src.includes('use `iris-verify-ui` instead'), 'UI verification must route to iris-verify-ui');
assert(src.includes('do not use this skill'), 'single media operations must not trigger composition');
assert(src.includes('If the user cancels, stop the chain'), 'cancellation must stop downstream work');

console.log('ALL OK —— iris-compose-media frontmatter、双语触发、10 工具编排、费用边界和异步停止约束全部通过');
