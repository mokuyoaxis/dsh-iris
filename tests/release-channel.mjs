import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [version, tag] of [['0.2.8', 'latest'], ['0.3.0-alpha.1', 'alpha'], ['0.3.0-beta.2', 'beta'], ['0.3.0-rc.1', 'rc'], ['0.3.0+build-alpha', 'latest']]) {
  assert.deepEqual(releaseMetadata(version, 'v' + version), { npmTag: tag, prerelease: tag !== 'latest' });
}
for (const version of ['0.3.0-latest.1', '0.3.0-next.1', '0.3.0-1', '0.3.0-alpha.01', '0.3.0-alpha.1\nNPM_DIST_TAG=latest', 'bad']) {
  assert.throws(() => releaseMetadata(version, 'v' + version));
}
assert.throws(() => releaseMetadata('0.3.0-alpha.1', 'v0.2.7'));
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const metadataCli = spawnSync(process.execPath, ['scripts/release-metadata.mjs', 'v' + current.version], { cwd: root, encoding: 'utf8', timeout: 15000 });
assert.ifError(metadataCli.error); assert.equal(metadataCli.status, 0, metadataCli.stderr);
const currentMetadata = releaseMetadata(current.version, 'v' + current.version);
assert.equal(metadataCli.stdout, `NPM_DIST_TAG=${currentMetadata.npmTag}\nRELEASE_PRERELEASE=${currentMetadata.prerelease}\n`);

// Run the actual Ubuntu workflow shell with local functions instead of remote
// commands. No registry, release, credential or daily installation is touched.
if (process.platform !== 'win32' && fs.existsSync('/bin/bash')) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-release-channel-'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  function step(name) {
    const start = workflow.indexOf('      - name: ' + name + '\n'); assert(start >= 0, name);
    const end = workflow.indexOf('\n      - ', start + 1);
    const section = workflow.slice(start, end < 0 ? undefined : end);
    const run = section.indexOf('        run: |\n'); assert(run >= 0, name);
    return section.slice(run + '        run: |\n'.length).split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  }
  assert(step('Verify tag and release channel').includes('node scripts/release-metadata.mjs "$GITHUB_REF_NAME" >> "$GITHUB_ENV"'));
  const fake = path.join(work, 'commands.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const [command,...args]=process.argv.slice(2), file=process.env.IRIS_RELEASE_FIXTURE;
const state=JSON.parse(fs.readFileSync(file)); state.calls.push({command,args});
let value='',status=0;
if(command==='npm'&&args[0]==='view'){
 if(args[2]==='version'){if(state.published)value=state.version;else status=1;}
 else if(args[2].startsWith('dist-tags.'))value=state.tags[args[2].slice(10)]||'';
 else status=1;
}else if(command==='npm'&&args[0]==='publish'){
 const at=args.indexOf('--tag');state.tags[at<0?'latest':args[at+1]]=state.version;state.published=true;
}else if(command==='gh'&&args[0]==='release'&&['list','create'].includes(args[1])){}
else status=2;
fs.writeFileSync(file,JSON.stringify(state));if(value)console.log(value);process.exitCode=status;
`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const shim = `npm() { ${quote(process.execPath)} ${quote(fake)} npm "$@"; }\ngh() { ${quote(process.execPath)} ${quote(fake)} gh "$@"; }\n`;
  for (const version of ['0.3.0-alpha.1', '0.2.8']) {
    const cwd = path.join(work, version); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: current.name, version }));
    const file = path.join(cwd, 'registry.json'), metadata = releaseMetadata(version, 'v' + version);
    fs.writeFileSync(file, JSON.stringify({ version, tags: { latest: '0.2.7' }, published: false, calls: [] }));
    const script = shim + [step('Create GitHub Release'), step('Publish to npm'), step('Verify npm publication')]
      .map(value => value.replaceAll('/tmp/iris-release-tags.txt', quote(path.join(cwd, 'tags.txt')))).join('\n');
    const run = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, IRIS_RELEASE_FIXTURE: file, GITHUB_REF_NAME: 'v' + version, TARBALL: 'candidate.tgz',
        NPM_DIST_TAG: metadata.npmTag, RELEASE_PRERELEASE: String(metadata.prerelease), GH_TOKEN: '', NODE_AUTH_TOKEN: '', NPM_TOKEN: '' } });
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    const state = JSON.parse(fs.readFileSync(file));
    assert.equal(state.tags[metadata.npmTag], version);
    assert.equal(state.tags.latest, metadata.prerelease ? '0.2.7' : version, 'alpha cannot move the stable npm tag');
    const release = state.calls.find(call => call.command === 'gh' && call.args[1] === 'create'); assert(release);
    assert.equal(release.args.includes('--prerelease'), metadata.prerelease);
    assert.equal(release.args.includes('--latest=false'), metadata.prerelease);
  }
  console.log('PASS release workflow: alpha preserves npm latest and creates a GitHub prerelease; stable uses latest; actual shell verified without remote calls');
} else console.log('PASS release metadata; Ubuntu Bash workflow integration skipped on this platform');
