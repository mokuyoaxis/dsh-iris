import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageFile = fileURLToPath(import.meta.resolve('@mokuyoaxis/dsh-iris/package.json'));
const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
export const coreCli = path.resolve(path.dirname(packageFile), metadata.bin['dsh-iris']);
export const cleanEnvironment = () => ({ ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', IRIS_CORE_CONNECTION_FILE: '', IRIS_CORE_SCOPES: '', NODE_OPTIONS: '' });
const execute = promisify(execFile);
export async function runCore(dataRoot, ...args) {
  return runCli([...args, '--data-root', dataRoot]);
}
export async function runCli(args) {
  const { stdout } = await execute(process.execPath, [coreCli, ...args], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: cleanEnvironment()
  });
  const value = JSON.parse(stdout);
  if (value.ok === false) throw new Error('Core command failed: ' + JSON.stringify(value));
  return value.result ?? value;
}
