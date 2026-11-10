import fs from 'node:fs';
import { executePublicationFixture } from './release-publication-fixture.mjs';

export function runFixtureCommand(command, args) {
  const file = process.env.IRIS_RELEASE_FIXTURE, state = JSON.parse(fs.readFileSync(file));
  const result = executePublicationFixture(state, command, args);
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exitCode = result.status;
}
