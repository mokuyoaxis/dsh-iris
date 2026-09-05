#!/usr/bin/env node
/**
 * 输出指定版本的发布说明，用于 GitHub Release 正文。
 * 用法：node scripts/release-notes.mjs <version>   （version 不带 v 前缀，如 0.1.1）
 * 优先级：
 *   1. docs/releases/<version>.md 存在 → 原样输出其内容（允许每版精修文案）；
 *   2. 否则从 CHANGELOG.md 提取 "## [<version>]" 小节正文（到下一个 "## [" 为止）；
 *   两个来源都缺失则退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('用法：release-notes.mjs <version>');
  process.exit(1);
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const overridePath = path.join(repoRoot, 'docs', 'releases', `${version}.md`);
if (fs.existsSync(overridePath)) {
  const custom = fs.readFileSync(overridePath, 'utf8').replaceAll('\r\n', '\n').trim();
  if (custom) {
    console.log(custom);
    process.exit(0);
  }
  console.error(`docs/releases/${version}.md 内容为空`);
  process.exit(1);
}

const changelog = path.join(repoRoot, 'CHANGELOG.md');
const lines = fs.readFileSync(changelog, 'utf8').replaceAll('\r\n', '\n').split('\n');

const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md 中没有 ${version} 的章节`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## [')) { end = i; break; }
}

const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`${version} 章节为空`);
  process.exit(1);
}
console.log(body);
