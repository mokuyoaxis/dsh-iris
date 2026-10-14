/**
 * Iris 随包 Skill 注册测试：发布物中的 Skill 必须能脱离仓库 cwd 注册到 DSH。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBundledSkills, registerBundledSkills } from '../lib/bundled-skills.js';
import { defineHostAdapter } from '../lib/host-contract.js';
import { EXPECTED_IRIS_SKILLS } from '../lib/host-runtime.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const originalCwd = process.cwd();
const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-skill-cwd-'));
try {
  process.chdir(unrelatedCwd);
  const loaded = loadBundledSkills();
  assert(loaded.length === 3, `应加载三项随包 Skill，实际 ${loaded.length}`);
  assert(loaded.map((skill) => skill.name).sort().join(',') === [...EXPECTED_IRIS_SKILLS].sort().join(','),
    `随包 Skill 名称错误：${loaded.map((skill) => skill.name).join(',')}`);
  for (const skill of loaded) {
    assert(skill.source === 'bundled' && skill.provider === 'iris-bundled', `${skill.name} 来源标记错误`);
    assert(skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true
      && Object.isFrozen(skill.invocation), `${skill.name} 必须明确允许模型和用户调用`);
    assert(skill.content.startsWith('# '), `${skill.name} 正文应剥离 YAML frontmatter`);
    assert(path.isAbsolute(skill.path) && fs.existsSync(skill.path), `${skill.name} path 必须指向包内文件`);
    assert(skill.resourceBase?.kind === 'directory' && fs.existsSync(skill.resourceBase.path),
      `${skill.name} resourceBase 必须指向包内目录`);
    assert(!skill.path.startsWith(unrelatedCwd), `${skill.name} 不得依赖会话 cwd`);
    // DSH rc.2 将相对资源按 skill.resourceBase 解析；共享参考也必须可从包中读取。
    for (const match of skill.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const resource = path.resolve(skill.resourceBase.path, match[1]);
      assert(fs.existsSync(resource), `${skill.name} 参考资源不可用：${match[1]}`);
    }
  }

  const registrations = [];
  const names = registerBundledSkills(defineHostAdapter({
    id: 'skill-test',
    ports: {
      skills: {
        register(skill) {
          registrations.push(skill);
          return () => {};
        }
      }
    }
  }));
  assert(names.join(',') === EXPECTED_IRIS_SKILLS.join(','), `注册结果错误：${names.join(',')}`);
  assert(registrations.length === 3, `Skill registry 应收到三次注册，实际 ${registrations.length}`);
  const sharedPaths = registrations.map(skill => {
    const shared = [...skill.content.matchAll(/\[[^\]]+\]\(([^)]+media-contract\.md)\)/g)][0];
    assert(shared, `${skill.name} 未连接共享产物说明`);
    return fs.realpathSync(path.resolve(skill.resourceBase.path, shared[1]));
  });
  assert(new Set(sharedPaths).size === 1, '三项 Skill 必须消费同一份能力与产物参考');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(unrelatedCwd, { recursive: true, force: true });
}

console.log('ALL OK —— 三项随包 Skill 可脱离 cwd 注册，共享参考按 DSH 资源基目录可读取');
