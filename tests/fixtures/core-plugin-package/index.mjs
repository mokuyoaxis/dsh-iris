// Independent author fixture: only the declared SDK export and Node globals.
import { definePlugin, defineProviderAdapter, normalizeMediaEndpoint } from '@mokuyoaxis/dsh-iris/plugins';
import fs from 'node:fs';

export function fixturePlugin({ version = '1.0.0', providerVersion = '1.0.0', operation, activated = () => {}, disposed = () => {} } = {}) {
  return definePlugin({
    manifest: { contractVersion: 0, id: 'example.media', version, compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' }, contributions: {
      providers: [{ id: 'images', version: providerVersion, title: 'Controlled fixture images', capabilities: ['image-gen'], configuration: [{ key: 'baseUrl', label: 'URL', type: 'url', required: true }] }],
      operations: [
        { id: 'list', version: '1.0.0', title: 'List images', mode: 'reader', commands: ['artifact.list'], inputSchema: {
          type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: [], additionalProperties: false } },
        { id: 'import', version: '1.0.0', title: 'Import an image', mode: 'writer', commands: ['artifact.import'], inputSchema: {
          type: 'object', properties: { image: { type: 'string', minLength: 1, maxLength: 200000 } }, required: ['image'], additionalProperties: false } }
      ],
      pages: [{ id: 'library', version: '1.0.0', title: 'Example library', entry: 'web/library.mjs', styles: ['web/style.css'] }],
      renderers: [{ id: 'png', version: '1.0.0', title: 'Example PNG renderer', entry: 'web/png.mjs', mediaTypes: ['image/png'] }]
    } },
    activate(context) {
      activated(); context.onDispose(disposed);
      return { providers: { images: { normalizeEndpoint: normalizeMediaEndpoint, supportsImageEdit: () => true,
        createAdapter(provider) {
          const request = async (suffix, signal, init) => {
            const response = await fetch(normalizeMediaEndpoint(provider.baseUrl) + suffix, { ...init, signal });
            if (!response.ok) throw new Error('Controlled provider HTTP ' + response.status);
            return response.json();
          };
          return defineProviderAdapter({ id: provider.id, protocol: 'example.media.images', capabilities: ['image'], operations: {
            submit: input => request('/submit', input.signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.input) }),
            poll: input => request('/tasks/' + encodeURIComponent(input.remoteTaskId), input.signal),
            download: async ({ artifact, targetPath }) => {
              const bytes = Buffer.from(artifact.data, 'base64'); fs.writeFileSync(targetPath, bytes, { flag: 'wx', mode: 0o600 });
              return { bytes: bytes.length };
            },
            mapError: error => error
          }, unsupported: { discover: 'fixture', cancel: 'fixture' } });
        }
      } }, operations: {
        list: operation || (async (input, { core }) => {
          const value = await core.execute('artifact.list', input); return { total: value.total };
        }),
        import: async (input, { core }) => {
          const value = await core.execute('artifact.import', { image_bytes: Buffer.from(input.image, 'base64') });
          return { artifactId: value.artifact.id };
        }
      } };
    }
  });
}
export default fixturePlugin();
