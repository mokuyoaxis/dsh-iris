import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A package with its own scope must consume Iris as a peer, including during source-tree tests. */
export async function loadCorePluginFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-fixture-'));
  fs.cpSync(fileURLToPath(new URL('./core-plugin-package/', import.meta.url)), directory, { recursive: true });
  const scope = path.join(directory, 'node_modules', '@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), path.join(scope, 'dsh-iris'), 'dir');
  const entry = path.join(directory, 'index.mjs');
  return { ...await import(pathToFileURL(entry).href), entry, directory };
}
