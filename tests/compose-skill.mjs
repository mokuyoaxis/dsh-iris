/** Check the published instruction resource graph against current Iris tool contracts. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadBundledSkills } from '../lib/bundled-skills.js';
import { EXPECTED_IRIS_TOOLS } from '../lib/host-runtime.js';

const known = new Set(EXPECTED_IRIS_TOOLS);
const visited = new Set();
const mentioned = new Set();
function inspect(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\biris_[a-z_]+\b/g)) {
    assert(known.has(match[0]), 'Skill references an unavailable Agent tool: ' + match[0]);
    mentioned.add(match[0]);
  }
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(match[1])) continue;
    const resource = path.resolve(path.dirname(file), match[1]);
    assert(fs.statSync(resource).isFile(), 'Missing instruction resource: ' + resource);
    inspect(resource);
  }
}
for (const skill of loadBundledSkills()) inspect(skill.path);
assert.deepEqual([...mentioned].sort(), [...known].sort(), '共享能力表应覆盖实际注册工具，不能遗漏改图或Music');
console.log('ALL OK —— 三项 Skill 的按需参考图可读取，工具名与当前16项契约一致');
