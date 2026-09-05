#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的发布说明。
 * 用法：node scripts/release-notes.mjs <version>   （version 不带 v 前缀，如 0.1.1）
 * 输出 "## [<version>]" 小节正文（到下一个 "## [" 为止）；找不到该小节则退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('用法：release-notes.mjs <version>');
  process.exit(1);
}

const changelog = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'CHANGELOG.md');
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
