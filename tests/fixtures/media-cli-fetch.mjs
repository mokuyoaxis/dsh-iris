import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listCoreTasks } from '../../lib/core-tasks.js';
import './headless-async-fetch.mjs';

const dataRoot = process.env.IRIS_MEDIA_FIXTURE_ROOT, eventsFile = process.env.IRIS_MEDIA_FIXTURE_EVENTS;
if (!dataRoot || !eventsFile) throw new Error('isolated media fixture root and event path required');
const fetch = globalThis.fetch;
const event = value => fs.appendFileSync(eventsFile, JSON.stringify(value) + '\n', { mode: 0o600 });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input), method = init.method || 'GET';
  const kind = /\/uploads\?/.test(url) ? 'policy' : url === 'https://upload.invalid' ? 'file'
    : method === 'POST' && /\/(generation|transcription|video-synthesis)$/.test(url) ? 'submit' : undefined;
  if (kind) {
    const pending = listCoreTasks(dataRoot, { limit: 200 }).tasks.filter(task => task.phase === 'submitting' && task.acceptance === 'none');
    assert.equal(pending.length, 1, 'every upload/submit must have exactly one durable submitting Task');
    const task = pending[0], attempt = task.attempts.at(-1);
    assert.equal(attempt.acceptance, 'none'); assert.equal(attempt.id, task.activeAttemptId);
    assert(init.signal, 'upload/submit must receive an abort signal');
    if (kind !== 'file') assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-' + task.providerId);
    event({ kind, taskId: task.id, attemptId: attempt.id, providerId: attempt.providerId });
    if (kind === process.env.IRIS_MEDIA_FIXTURE_PAUSE) {
      await new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        const aborted = () => {
          clearInterval(keepAlive); event({ kind: 'aborted', taskId: task.id, attemptId: attempt.id });
          reject(new DOMException('fixture upload aborted', 'AbortError'));
        };
        if (init.signal.aborted) aborted();
        else init.signal.addEventListener('abort', aborted, { once: true });
      });
    }
    if (kind === 'policy' && (process.env.IRIS_MEDIA_FIXTURE_REJECT_PROVIDER || '').split(',').includes(task.providerId)) {
      return Response.json({ message: 'fixture upload policy rejected' }, { status: 401 });
    }
  }
  return fetch(input, init);
};
