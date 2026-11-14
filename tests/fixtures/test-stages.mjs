import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// Fixture-only deadlines and durable phase records; never log request bodies or credentials.
export function createTestStages(test, snapshot) {
  const started = performance.now(); let sequence = 0;
  function record(event, details) {
    writeSync(1, test + ' ' + JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid,
      testElapsedMs: Math.round(performance.now() - started), ...details }) + '\n');
  }
  async function stage(phase, action, timeoutMs = 5000) {
    const id = ++sequence, began = performance.now(), wall = Date.now(), cpu = process.cpuUsage(), abort = new AbortController();
    const timing = () => ({ elapsedMs: Math.round(performance.now() - began), wallElapsedMs: Date.now() - wall,
      timerLatenessMs: Math.max(0, Math.round(performance.now() - began - timeoutMs)), cpuMicros: process.cpuUsage(cpu) });
    const expired = () => Object.assign(new Error('Test phase timed out: ' + phase), { code: 'IRIS_TEST_STAGE_TIMEOUT', phase, timeoutMs });
    record('start', { id, phase, timeoutMs }); let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = expired(); abort.abort(error); reject(error); }, timeoutMs); });
      const result = await Promise.race([Promise.resolve().then(() => action(abort.signal)), deadline]);
      if (performance.now() - began >= timeoutMs) { const error = expired(); abort.abort(error); throw error; }
      record('complete', { id, phase, ...timing() }); return result;
    } catch (error) {
      let state;
      try { state = snapshot(); }
      catch (diagnostic) { state = { diagnosticError: { name: diagnostic.name, code: diagnostic.code } }; }
      record('failure', { id, phase, timeoutMs, ...timing(), error: { name: error.name, code: error.code },
        activeResources: process.getActiveResourcesInfo(), state });
      throw error;
    } finally { clearTimeout(timer); }
  }
  stage.mark = (event, details) => record(event, details);
  return stage;
}
