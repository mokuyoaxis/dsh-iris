/**
 * Iris 随包 Skill 注册测试：发布物中的 Skill 必须能脱离仓库 cwd 注册到 DSH。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBundledSkills, registerBundledSkills } from '../lib/bundled-skills.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const originalCwd = process.cwd();
const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-skill-cwd-'));
try {
  process.chdir(unrelatedCwd);
  const loaded = loadBundledSkills();
  assert(loaded.length === 2, `应加载两项随包 Skill，实际 ${loaded.length}`);
  assert(loaded.map((skill) => skill.name).sort().join(',') === 'iris-compose-media,iris-verify-ui',
    `随包 Skill 名称错误：${loaded.map((skill) => skill.name).join(',')}`);
  for (const skill of loaded) {
    assert(skill.source === 'bundled' && skill.provider === 'iris-bundled', `${skill.name} 来源标记错误`);
    assert(skill.content.startsWith('# '), `${skill.name} 正文应剥离 YAML frontmatter`);
    assert(path.isAbsolute(skill.path) && fs.existsSync(skill.path), `${skill.name} path 必须指向包内文件`);
    assert(skill.resourceBase?.kind === 'directory' && fs.existsSync(skill.resourceBase.path),
      `${skill.name} resourceBase 必须指向包内目录`);
    assert(!skill.path.startsWith(unrelatedCwd), `${skill.name} 不得依赖会话 cwd`);
  }

  const registrations = [];
  const names = registerBundledSkills({
    skills: {
      register(skill) {
        registrations.push(skill);
        return () => {};
      }
    }
  });
  assert(names.join(',') === 'iris-verify-ui,iris-compose-media', `注册结果错误：${names.join(',')}`);
  assert(registrations.length === 2, `Skill registry 应收到两次注册，实际 ${registrations.length}`);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(unrelatedCwd, { recursive: true, force: true });
}

console.log('ALL OK —— 两项随包 Skill 可脱离仓库 cwd 加载并注册');
