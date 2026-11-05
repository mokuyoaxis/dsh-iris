import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plugin, { PROVIDER_PROTOCOL } from '../index.mjs';
import { coreCli, runCore } from './core-cli.mjs';

export async function setup({ directory, endpoint, credentialEnv }) {
  if (!path.isAbsolute(directory)) throw new Error('--directory must be an absolute path to a new directory.');
  if (typeof credentialEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credentialEnv)) throw new Error('--credential-env must be an environment variable name, never a key value.');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /\/(?:api\/v1|compatible-mode\/v1)\/?$/.test(url.pathname)) throw new Error('--endpoint must be the explicit workspace API root, without credentials, query or /api/v1.');
  // Resolve the existing parent so a symlink cannot put private data in the distributed project.
  const projectRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const target = path.join(await realpath(path.dirname(directory)), path.basename(directory));
  const relative = path.relative(projectRoot, target);
  if (relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Demo data must be outside the plugin project.');
  // Reject all existing directories, including empty ones; leave partial output for diagnosis on failure.
  await mkdir(target, { mode: 0o700 });
  const dataRoot = path.join(target, 'core'), providerConfigPath = path.join(target, 'providers.json'),
    configPath = path.join(target, 'plugins.json'), connectionStore = path.join(target, 'connections');
  const entry = fileURLToPath(new URL('../index.mjs', import.meta.url));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 0, entries: [entry] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(providerConfigPath, JSON.stringify({ providers: [{ id: 'wan-reference', name: 'Wan reference',
    enabled: true, baseUrl: endpoint.replace(/\/+$/, ''), apiKeyEnv: credentialEnv, mediaProtocol: PROVIDER_PROTOCOL, models: [] }],
    assignments: { 'image-gen': { mode: 'disabled', models: [] } } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await runCore(dataRoot, 'flow', 'init');
  await runCore(dataRoot, 'execution', 'init', '--image-generation');
  return { directory: target, dataRoot, configPath, providerConfigPath, connectionStore, entry,
    pluginId: plugin.manifest.id,
    startArgv: [process.execPath, coreCli, 'web', 'serve', '--data-root', dataRoot, '--plugin-config', configPath,
      '--provider-config', providerConfigPath, '--allow-provider-management', '--allow-execution',
      '--connection-store', connectionStore, '--allow-connection-management', '--allow-mcp', '--port', '3182'] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), allowed = ['--directory', '--endpoint', '--credential-env'];
  if (args.length !== 6 || allowed.some(name => args.filter(item => item === name).length !== 1)
      || args.some((value, index) => index % 2 === 0 && !allowed.includes(value))) {
    throw new Error('Usage: npm run setup -- --directory /absolute/new-private-directory --endpoint https://YOUR-WORKSPACE-API-ROOT --credential-env YOUR_KEY_VARIABLE');
  }
  const options = Object.fromEntries(args.reduce((pairs, value, index) => index % 2 ? [...pairs, [args[index - 1].slice(2), value]] : pairs, []));
  console.log(JSON.stringify(await setup({ directory: options.directory, endpoint: options.endpoint, credentialEnv: options['credential-env'] }), null, 2));
}
