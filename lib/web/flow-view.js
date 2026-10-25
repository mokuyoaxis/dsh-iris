// Consume the HTTP DTO, not private Core records or the prototype's in-memory transport.
export function presentReadOnlyFlow(view) {
  if (view.contractVersion !== 0 || view.recipe !== 'image-edit/v0') throw new TypeError('不支持的流程版本');
  switch (view.status) {
    case 'not_started': return { title: '已保存，尚未开始', message: '输入已保存。当前页面只读，不会提交生成。', tone: 'neutral' };
    case 'running': return { title: '原任务进行中', message: '这是本地保存的进展。页面刷新不会查询模型服务；可通过 CLI 查看原任务。', tone: 'working' };
    case 'needs_attention': return { title: '需要核对原任务', message: view.task?.acceptance === 'unknown' || view.task?.outcome === 'unknown'
      ? '尚不能确认原请求的结果，可能已经计费。请核对原任务，避免重复生成。'
      : '原任务已失败或取消。现有记录仍然保留。', tone: 'warning' };
    case 'delivery_failed': return { title: '原结果待保存', message: '生成已经成功，本地保存尚未完成。请通过 CLI 恢复原结果。', tone: 'warning' };
    case 'needs_comparison': return { title: '结果已保存', message: '本地比较尚未完成。可查看现有图片，通过 CLI 继续流程。', tone: 'neutral' };
    case 'awaiting_selection': return { title: '图片已就绪', message: '原图与结果已保存。请通过 CLI 明确选择作品，再回来下载。', tone: 'success' };
    case 'selected': return { title: view.selection?.artifactId === view.source.artifactId ? '已选择原图' : '已选择结果',
      message: '选择已记录，可以下载原始图片。', tone: 'success' };
    default: throw new TypeError('不支持的流程状态，请核对服务版本');
  }
}

export function presentFlow(view, operations) {
  const base = presentReadOnlyFlow(view), execute = operations.includes('runs.continue');
  if (execute && view.status === 'not_started') return { ...base, message: '输入已固定。明确开始后才会调用模型，可能产生费用。' };
  if (execute && view.status === 'running') return { ...base, message: '原任务仍在进行。点击“查看原任务”读取一次进展；刷新只读本地记录。' };
  if (execute && view.status === 'delivery_failed') return { ...base, message: '生成已经成功。点击“恢复原结果”接回交付，不新建生成。' };
  if (execute && view.status === 'needs_comparison') return { ...base, message: '图片已保存。点击“完成比较”执行本地比较，不产生生成请求。' };
  if (operations.includes('runs.select') && view.status === 'awaiting_selection') return { ...base, message: '比较原图与结果，选择喜欢的版本，再下载原始图片。' };
  return base;
}
