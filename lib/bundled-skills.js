'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAMES = ['iris-verify-ui', 'iris-compose-media'];
const SKILL_ROOT = fileURLToPath(new URL('../.dsh/skills/', import.meta.url));

function parseScalar(value, file) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`随包 Skill frontmatter 字符串无效：${file}: ${error.message}`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

/** 读取由 Iris 自己发布的固定 Skill；不把此解析器当作通用 YAML 解析器。 */
export function loadBundledSkills() {
  return SKILL_NAMES.map((expectedName) => {
    const directory = path.join(SKILL_ROOT, expectedName);
    const file = path.join(directory, 'SKILL.md');
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!frontmatter) throw new Error(`随包 Skill 缺少 frontmatter：${file}`);

    const nameLine = frontmatter[1].match(/^name:\s*(.+)$/m);
    const descriptionLine = frontmatter[1].match(/^description:\s*(.+)$/m);
    const name = nameLine ? parseScalar(nameLine[1], file) : '';
    const description = descriptionLine ? parseScalar(descriptionLine[1], file) : '';
    if (name !== expectedName) throw new Error(`随包 Skill 名称不匹配：${file}`);
    if (!description) throw new Error(`随包 Skill 缺少 description：${file}`);

    return Object.freeze({
      name,
      description,
      content: source.slice(frontmatter[0].length).replace(/^\r?\n/, ''),
      source: 'bundled',
      provider: 'iris-bundled',
      path: file,
      resourceBase: Object.freeze({ kind: 'directory', path: directory })
    });
  });
}

/** 注册为宿主级 runtime Skill；DSH 项目目录中的同名 Skill 仍按原生优先级胜出。 */
export function registerBundledSkills(ctx) {
  const registry = ctx && (ctx.skills || (typeof ctx.get === 'function' && ctx.get('skills')));
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('DSH Skill registry 不可用');
  }
  const skills = loadBundledSkills();
  for (const skill of skills) registry.register(skill);
  return skills.map((skill) => skill.name);
}
