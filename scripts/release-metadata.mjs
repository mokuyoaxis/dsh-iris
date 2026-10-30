import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePluginVersions } from '../lib/plugin-contract.js';

export function releaseMetadata(version, tag) {
  comparePluginVersions(version, version);
  if (tag !== 'v' + version) throw new Error('Git 标签必须与 package.json version 完全一致');
  const prerelease = /^[0-9]+\.[0-9]+\.[0-9]+-([^+]+)/.exec(version)?.[1];
  const npmTag = prerelease ? prerelease.split('.')[0] : 'latest';
  if (prerelease && !['alpha', 'beta', 'rc'].includes(npmTag)) throw new Error('预发布仅支持 alpha、beta 或 rc 渠道，拒绝使用 latest');
  return { npmTag, prerelease: Boolean(prerelease) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const metadata = releaseMetadata(version, process.argv[2]);
    console.log('NPM_DIST_TAG=' + metadata.npmTag + '\nRELEASE_PRERELEASE=' + metadata.prerelease);
  } catch (error) {
    console.error('release-metadata: ' + error.message);
    process.exitCode = 1;
  }
}
