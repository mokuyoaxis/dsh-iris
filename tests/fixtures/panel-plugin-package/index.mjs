import { definePlugin } from '@mokuyoaxis/dsh-iris/plugins';

export default definePlugin({
  manifest: { contractVersion: 0, id: 'example.panel', version: '1.0.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' }, contributions: {
    pages: [
      { id: 'library', title: '扩展作品台', version: '1.0.0', entry: 'web/library.mjs', styles: ['web/style.css'] },
      { id: 'slow', title: '延迟挂载', version: '1.0.0', entry: 'web/slow.mjs' },
      { id: 'broken', title: '错误定位', version: '1.0.0', entry: 'web/broken.mjs' },
      { id: 'module', title: '模块契约错误', version: '1.0.0', entry: 'web/module.mjs' },
      { id: 'hidden', title: '未选页面', version: '1.0.0', entry: 'web/hidden.mjs' }
    ],
    settings: [{ id: 'connection', title: '扩展服务表单', version: '1.0.0', entry: 'web/settings.mjs', styles: ['web/style.css'] }],
    renderers: [{ id: 'png', title: '原图与像素信息', version: '1.0.0', entry: 'web/png.mjs', styles: ['web/style.css'], mediaTypes: ['image/png'] }]
  } },
  activate() { return {}; }
});
