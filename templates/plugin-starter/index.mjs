import { definePlugin } from '@mokuyoaxis/dsh-iris/plugins';
import contactSheet from '@mokuyoaxis/dsh-iris/contact-sheet';

// Review the delegated business before changing persistent operation semantics.
// This version is independent of both the npm package and Core's version.
if (contactSheet.manifest.version !== '0.1.0') {
  throw new Error('Starter expects contact-sheet 0.1.0; review its changes and this plugin version before upgrading.');
}

export default definePlugin({
  manifest: {
    contractVersion: 0,
    id: 'example.starter-board',
    version: '0.1.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      operations: contactSheet.manifest.contributions.operations,
      pages: [{ id: 'board', version: '0.1.0', title: '灵感对照板', entry: 'web/board.mjs', styles: ['web/board.css'] }],
      renderers: [{ id: 'png', version: '0.1.0', title: '对照板预览', entry: 'web/png.mjs', styles: ['web/board.css'], mediaTypes: ['image/png'] }]
    }
  },
  activate(context) {
    // Core owns execution, permissions and artifact storage. No new queue/root.
    // If you acquire resources here, register real cleanup with context.onDispose.
    return contactSheet.activate(context);
  }
});
