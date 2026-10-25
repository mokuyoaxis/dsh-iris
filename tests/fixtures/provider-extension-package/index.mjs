// Independent package: only the declared Iris experiment boundary and Node standard library.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { defineProviderAdapter, ProviderContractError, normalizeMediaEndpoint } from '@mokuyoaxis/dsh-iris/provider-extensions';

export default function createFixtureExtension() {
  const event = kind => {
    if (process.env.IRIS_EXTENSION_TEST_LOG) fs.appendFileSync(process.env.IRIS_EXTENSION_TEST_LOG, JSON.stringify({ kind, pid: process.pid }) + '\n');
  };
  event('activate');
  return { contractVersion: 0, id: 'fixture.external-media', version: '1.0.0',
    dispose: async () => { event('dispose'); },
    protocols: [{ id: 'fixture-images', label: 'Independent fixture images', capabilities: ['image-gen'],
      normalizeEndpoint: normalizeMediaEndpoint, supportsImageEdit: () => true,
      configuration: [{ key: 'baseUrl', label: 'Endpoint', type: 'url', required: true }, { key: 'apiKey', label: 'API Key', type: 'secret' }],
      createAdapter(provider) {
        const base = normalizeMediaEndpoint(provider.mediaBaseUrl || provider.baseUrl);
        async function request(route, options = {}) {
          const response = await fetch(base + route, { ...options, headers: { Authorization: 'Bearer ' + provider.apiKey,
            'Content-Type': 'application/json' }, signal: options.signal });
          if (!response.ok) throw new ProviderContractError('Fixture provider rejected request', {
            stage: 'response', category: 'invalid_request', acceptance: 'not_accepted', httpStatus: response.status });
          return response.json();
        }
        return defineProviderAdapter({ id: provider.id, protocol: 'fixture-images', capabilities: ['image'], operations: {
          async discover({ signal }) { return { models: (await request('/models', { signal })).models }; },
          async submit({ model, input, signal }) {
            const value = await request('/jobs', { method: 'POST', signal, body: JSON.stringify({ model, prompt: input.prompt,
              ...(input.image ? { imageDigest: crypto.createHash('sha256').update(input.image.bytes).digest('hex') } : {}) }) });
            return { kind: 'accepted', remoteTaskId: value.id };
          },
          async poll({ remoteTaskId, signal }) {
            const value = await request('/jobs/' + encodeURIComponent(remoteTaskId), { signal });
            return value.ready ? { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: value.url, mediaType: 'image/png' }] }
              : { kind: 'pending' };
          },
          async download({ artifact, targetPath, signal }) {
            const response = await fetch(artifact.url, { signal });
            if (!response.ok) throw new Error('fixture download failed');
            const bytes = Buffer.from(await response.arrayBuffer()); fs.writeFileSync(targetPath, bytes);
            return { bytes: bytes.length };
          },
          mapError(error, context) { return new ProviderContractError('Independent fixture transport error', {
            stage: context.stage, acceptance: context.acceptance || 'unknown', category: 'network' }); }
        }, unsupported: { cancel: 'Fixture protocol has no remote cancel' } });
      } }] };
}
