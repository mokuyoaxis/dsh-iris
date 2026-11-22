import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { createVisionProviderAdapter } from '../../lib/vision-provider-adapter.js';
import { VIDEO_MODEL, videoFlowFixture } from './video-flow-fixture.mjs';

export const SUMMARY_MODEL = 'summary-fixture::vision';
export const SUMMARY_TEXT = '视频里的紫色花朵由左向右摇动。<b>文字保留原样</b>';

export async function summaryWorkbenchFixture(out) {
  const dataRoot = path.join(out, 'summary-core'), config = path.join(out, 'summary-providers.json');
  const provider = { id: 'summary-fixture', type: 'openai', baseUrl: 'https://summary.invalid/v1', apiKey: 'CONTROLLED_SUMMARY_FIXTURE',
    models: [{ id: 'vision', capabilities: ['vision'] }] };
  fs.writeFileSync(config, JSON.stringify({ providers: [provider], assignments: { vision: [SUMMARY_MODEL] } }), { mode: 0o600 });
  const visionRequests = [], video = videoFlowFixture(), binding = 'sha256:' + 'e'.repeat(64);
  const adapter = createVisionProviderAdapter(provider, { fetchPort: async (url, request) => {
    visionRequests.push({ url, method: request.method, body: JSON.parse(request.body) });
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: SUMMARY_TEXT }, finish_reason: null }] })
      + '\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const ports = {
    resolveVisionCandidates({ modelRef }) {
      if (modelRef !== SUMMARY_MODEL) throw new Error('unexpected fixture model');
      return [{ adapter, model: SUMMARY_MODEL, providerBinding: binding, selectionReason: 'explicit' }];
    },
    resolveTaskAdapter(task) {
      if (task.capability !== 'vision' || task.providerBinding !== binding) throw new Error('unexpected fixture task');
      return adapter;
    }
  };
  const app = createApplicationRuntime({ dataRoot, ...video });
  try {
    await app.execute('flow.init', {});
    await app.execute('execution.init', { vision: true });
    const created = await app.execute('creation.video', { key: crypto.randomUUID(), value: { modelRef: VIDEO_MODEL, prompt: 'Saved video fixture' } });
    const videoRunId = created.flow.run.id;
    await app.execute('flow.continue', { run_id: videoRunId });
    const delivered = await app.execute('flow.continue', { run_id: videoRunId });
    return { dataRoot, config, ports, visionRequests, videoRunId, videoArtifactId: delivered.run.output.artifactId };
  } finally { await app.dispose(); }
}
