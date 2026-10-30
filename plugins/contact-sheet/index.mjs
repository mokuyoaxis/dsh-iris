import sharp from 'sharp';
import { definePlugin } from '@mokuyoaxis/dsh-iris/plugins';

/** Optional real business plugin. Uses public SDK and Sharp only; no filesystem or Core internals. */
export default definePlugin({
  manifest: { contractVersion: 0, id: 'community.contact-sheet', version: '0.1.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' }, contributions: {
    operations: [{ id: 'create', version: '0.1.0', title: '多图对照板', mode: 'writer',
      commands: ['artifact.read', 'artifact.import'], artifactInputs: ['artifactIds'],
      inputSchema: { type: 'object', properties: {
        artifactIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' } },
        columns: { type: 'integer', minimum: 1, maximum: 4 }, cellSize: { type: 'integer', minimum: 128, maximum: 512 }
      }, required: ['artifactIds', 'columns', 'cellSize'], additionalProperties: false }
    }],
    pages: [{ id: 'board', version: '0.1.0', title: '多图对照板', entry: 'web/board.mjs', styles: ['web/board.css'] }]
  } },
  activate() {
    return { operations: { async create(input, { core, signal }) {
      const cells = [], columns = Math.min(input.columns, input.artifactIds.length), gap = 12;
      for (const [index, id] of input.artifactIds.entries()) {
        signal.throwIfAborted();
        const image = await core.execute('artifact.read', { artifact_id: id });
        const bytes = await sharp(Buffer.from(image.imageBase64, 'base64'), { limitInputPixels: 40_000_000 })
          .rotate().resize(input.cellSize, input.cellSize, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
        cells.push({ input: bytes, left: gap + index % columns * (input.cellSize + gap), top: gap + Math.floor(index / columns) * (input.cellSize + gap) });
      }
      const width = columns * (input.cellSize + gap) + gap, height = Math.ceil(cells.length / columns) * (input.cellSize + gap) + gap;
      const image = await sharp({ create: { width, height, channels: 3, background: '#f4f2f8' } }).composite(cells).png().toBuffer();
      signal.throwIfAborted();
      const result = await core.execute('artifact.import', { image_bytes: image });
      return { artifactId: result.artifact.id, mediaType: 'image/png', width, height, count: input.artifactIds.length };
    } } };
  }
});
