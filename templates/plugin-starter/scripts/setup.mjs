import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreCli, runCore } from './core-cli.mjs';

export async function setup(directory) {
  if (!path.isAbsolute(directory)) throw new Error('--directory must be an absolute path to a new directory.');
  const projectRoot = fileURLToPath(new URL('..', import.meta.url)), relative = path.relative(projectRoot, directory);
  if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Demo data must be outside the plugin project so it cannot enter its npm package.');
  }
  // EEXIST deliberately rejects existing user data, including empty directories.
  await mkdir(directory, { mode: 0o700 });
  const dataRoot = path.join(directory, 'core'), connectionStore = path.join(directory, 'connections');
  const entry = fileURLToPath(new URL('../index.mjs', import.meta.url));
  const config = {
    schemaVersion: 0, entries: [entry], operations: ['example.starter-board.create'],
    panel: { pages: ['example.starter-board.board'], renderers: ['example.starter-board.png'] }
  };
  const configPath = path.join(directory, 'plugins.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await runCore(dataRoot, 'flow', 'init');
  await runCore(dataRoot, 'execution', 'init');
  const artifactIds = [];
  for (const name of ['violet.png', 'peach.png']) {
    const imagePath = fileURLToPath(new URL('../assets/' + name, import.meta.url));
    const result = await runCore(dataRoot, 'artifact', 'import', '--input', JSON.stringify({ image_path: imagePath }));
    artifactIds.push(result.artifact.id);
  }
  return { directory, dataRoot, connectionStore, configPath, entry, artifactIds };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--directory') {
    throw new Error('Usage: npm run setup -- --directory /absolute/new-private-directory');
  }
  const result = await setup(process.argv[3]);
  // Exact argv avoids shell quoting assumptions; no server or browser is started.
  console.log(JSON.stringify({ ...result, startArgv: [process.execPath, coreCli, 'web', 'serve',
    '--data-root', result.dataRoot, '--plugin-config', result.configPath,
    '--connection-store', result.connectionStore, '--allow-connection-management', '--allow-mcp', '--port', '3182'] }, null, 2));
}
