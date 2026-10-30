import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createPanelPluginFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-panel-plugin-'));
  fs.cpSync(fileURLToPath(new URL('./panel-plugin-package/', import.meta.url)), directory, { recursive: true });
  const scope = path.join(directory, 'node_modules/@mokuyoaxis'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), path.join(scope, 'dsh-iris'), 'dir');
  return { entry: path.join(directory, 'index.mjs'), directory };
}
