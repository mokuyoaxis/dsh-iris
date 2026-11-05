import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startSyntaxCheck } from '../scripts/lint-syntax.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-lint-coverage');
const source = fs.readFileSync(new URL('./lint.mjs', import.meta.url), 'utf8');
for (const name of ['lib', 'bin', 'tests', 'scripts', 'prototypes/workbench', 'templates', 'plugins/example']) fs.mkdirSync(path.join(root, name), { recursive: true });
const plugin = path.join(root, 'plugins/example/index.mjs'); fs.writeFileSync(plugin, 'export function broken( {');
const begin = source.indexOf('function walk('), end = source.indexOf("stage('syntax'", begin);
const context = { fs, path, root, trace() {} };
vm.runInNewContext(source.slice(begin, end) + '\nglobalThis.discovered = files;', context);
const contractStart = source.indexOf("const userProjection = read('lib/core-user-projection.js')"), contractEnd = source.indexOf('for (const phrase of', contractStart);
function contract(body) {
  const failures = [];
  vm.runInNewContext(source.slice(contractStart, contractEnd), { read: () => body, failures });
  return failures.length;
}
const observations = { pluginDiscovered: context.discovered.includes(plugin),
  independentProjectionAccepted: contract('export function projectCoreTaskUserView() {}') === 0,
  missingExportDetected: contract("import { deriveUserState } from './task-semantics.js';") > 0,
  missingExportWithoutImportDetected: contract('const unrelated = true;') > 0 };
const retryStart = source.indexOf('  if (!/normalizeGenerationInput\\('), retryEnd = source.indexOf("  if (!cliSource.includes('run transcribe')", retryStart);
const command = fs.readFileSync(new URL('../lib/command-service.js', import.meta.url), 'utf8');
const generation = fs.readFileSync(new URL('../lib/generation-input.js', import.meta.url), 'utf8');
function retryGuard(commandSource, generationSource = generation) {
  const failures = [];
  vm.runInNewContext(source.slice(retryStart, retryEnd), { failures, read: name => name.endsWith('command-service.js') ? commandSource : generationSource });
  return failures.length;
}
observations.currentRetryAccepted = retryGuard(command) === 0;
observations.missingRetryNormalizationDetected = retryGuard(command.replaceAll('normalizeGenerationInput(', 'removedNormalization(')) > 0;
observations.missingAudioMappingDetected = retryGuard(command, generation.replace('providerInput.audioUrl = audioUrl', '')) > 0;
console.log(JSON.stringify(observations));
assert(Object.values(observations).every(Boolean), 'each broken contract and plugin syntax file must be checked');
assert.equal(contract("import { deriveUserState } from './task-semantics.js'; export function projectCoreTaskUserView() {}"), 0);
const syntax = await startSyntaxCheck(plugin).completion;
assert.equal(syntax.status, 1); assert.match(syntax.stderr, /SyntaxError/);
console.log('PASS actual lint discovers plugins and requires the projection export regardless of imports; a pure projection needs no unused import, and malformed plugins reach Node syntax validation');
