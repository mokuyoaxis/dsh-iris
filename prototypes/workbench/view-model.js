// Draft HTTP projection shared by the static prototype and its Core-backed tests.
// No storage, configuration, network or generation side effects.
const STATUSES = new Set(['not_started', 'running', 'needs_attention', 'delivery_failed',
  'needs_comparison', 'awaiting_selection', 'selected']);

export function projectFlowFacts(facts) {
  if (facts.contractVersion !== 0 || facts.run.recipe !== 'image-edit/v0' || !STATUSES.has(facts.status)) {
    throw new TypeError('不支持的流程契约或状态');
  }
  const { run, task } = facts;
  const ref = value => value ? { artifactId: value.artifactId } : null;
  return {
    contractVersion: 0, id: run.id, recipe: run.recipe, revision: run.revision,
    createdAt: run.createdAt, updatedAt: run.updatedAt, status: facts.status,
    input: { prompt: run.input.prompt, modelRef: run.input.model_ref,
      ...(run.input.size !== undefined ? { size: run.input.size } : {}) },
    source: ref(run.source), output: ref(run.output), comparison: ref(run.comparison), selection: ref(run.selection),
    task: task ? { id: task.id, acceptance: task.acceptance, outcome: task.outcome,
      deliveryState: task.deliveryState, attemptCount: task.attempts.length } : null,
    metrics: facts.metrics ? Object.fromEntries(['ratio', 'diffPixels', 'totalPixels', 'width', 'height']
      .map(key => [key, facts.metrics[key]])) : null
  };
}

export function presentFlow(view) {
  switch (view.status) {
    case 'not_started': return { title: '准备就绪', tone: 'neutral', action: 'start', label: '开始生成',
      message: '输入已固定。只有明确开始，才会提交给所选模型。' };
    case 'running': return { title: '原任务进行中', tone: 'working', action: 'observe', label: '查看原任务',
      message: '原任务已受理。点击查看只查询它的进展，不会另开一次生成。' };
    case 'needs_attention': return { title: '需要确认', tone: 'warning', action: null,
      message: view.task?.acceptance === 'unknown' || view.task?.outcome === 'unknown'
        ? '尚不能确认原请求的结果，可能已经计费。已停止自动操作，请核对原任务。'
        : '原任务已失败或取消。保留现有记录；需要再次生成时，请明确新建流程。' };
    case 'delivery_failed': return { title: '结果待保存', tone: 'warning', action: 'redeliver', label: '恢复结果',
      message: '生成已经成功，本地保存尚未完成。恢复会接回原结果，不会重新生成。' };
    case 'needs_comparison': return { title: '结果已就绪', tone: 'neutral', action: 'compare', label: '完成比较',
      message: '原结果已经保存。继续完成本地比较，再选择要保留的图片。' };
    case 'awaiting_selection': return { title: '等待你的选择', tone: 'success', action: null,
      message: '比较已经就绪。选择原图或结果，再下载到设备。' };
    case 'selected': return { title: view.selection?.artifactId === view.source.artifactId ? '已选择原图' : '已选择结果',
      tone: 'success', action: null, message: '选择已经记录。下载是下一步，文件由浏览器保存。' };
    default: throw new TypeError('不支持的流程状态');
  }
}

export function canSelect(view) { return view.status === 'awaiting_selection' || view.status === 'selected'; }
