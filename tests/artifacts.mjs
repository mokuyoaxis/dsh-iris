/**
 * 作品库 v0：任务历史和作品生命周期独立，旧 outputs 可重建最小索引。
 * 零网络、零费用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-artifacts-home');
const outputs = path.join(root, 'iris', 'v1', 'outputs');
fs.mkdirSync(outputs, { recursive: true });
fs.writeFileSync(path.join(outputs, 'legacy.png'), 'old-image');

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const artifacts = await import('../lib/artifacts.js');
const tasks = await import('../lib/tasks.js');
const media = await import('../lib/media.js');
const { runAction } = await import('../lib/actions.js');

// 首次运行直接接回升级前 outputs，不需要任务记录。
let page = artifacts.page({ limit: 10 });
assert(page.total === 1 && page.items[0].file === 'legacy.png', '首次加载找回旧 outputs', page);
assert(!('prompt' in page.items[0]) && !('provider' in page.items[0]) && !('taskId' in page.items[0]),
  '最小作品索引不保留任务隐私元数据', page.items[0]);
assert(fs.existsSync(path.join(root, 'iris', 'v1', 'artifacts.json')), 'artifacts.json 已落盘');

// 新产物随 registerMedia 自动入库。
const generated = path.join(outputs, 'generated.mp4');
fs.writeFileSync(generated, 'video-bytes');
const task = tasks.create({ cap: 'video', providerId: 'p', model: 'm', prompt: 'private prompt' });
const taskMedia = media.registerMedia(task.id, generated);
tasks.update(task.id, { status: 'succeeded' });
page = artifacts.page({ limit: 10 });
const work = page.items.find((item) => item.file === 'generated.mp4');
assert(taskMedia && work && work.url.includes('/iris/media/artifact/'), '新产物自动进入独立作品库', work);

// 清任务历史后，作品授权仍然成立，且任务级 token 自然失效。
const cleared = await runAction({}, 'tasks_clear', { scope: 'completed' });
assert(cleared.removed === 1 && !tasks.get(task.id), '终态任务记录已清除', cleared);
const parsed = new URL(work.url);
const parts = parsed.pathname.split('/').filter(Boolean);
assert(artifacts.authorize(parts[3], parts[4], decodeURIComponent(parts[5]))?.abs === generated,
  '清历史后作品仍可授权访问');
assert(media.authorizeMedia(task.id, taskMedia.token, 'generated.mp4') === null,
  '清历史后旧任务链接失效');

// 作品库文件不会被孤儿清理误删。
const orphanReport = await runAction({}, 'tasks_orphans', {});
assert(orphanReport.count === 0, '已入库作品不属于孤儿产物', orphanReport);

// 手工补入 outputs 后可以找回；删除作品单独删除文件。
fs.writeFileSync(path.join(outputs, 'found.wav'), 'audio');
const indexed = await runAction({}, 'artifacts_reindex', {});
assert(indexed.added === 1 && indexed.total === 3, '重新扫描找回本地作品', indexed);
const legacy = artifacts.page({ limit: 10 }).items.find((item) => item.file === 'legacy.png');
const removed = await runAction({}, 'artifacts_delete', { artifact_id: legacy.id });
assert(removed.ok && !fs.existsSync(path.join(outputs, 'legacy.png')), '单件删除同时删除作品文件', removed);

const emptied = await runAction({}, 'artifacts_clear', {});
assert(emptied.ok && emptied.deleted === 2 && artifacts.page().total === 0, '独立确认后可清空作品库', emptied);

console.log('ALL OK —— 作品库旧文件接回、自动入库、清历史保留、孤儿保护、重新索引与独立删除全部通过');
