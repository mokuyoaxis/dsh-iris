import { taskWaitFinished, taskTerminalProblem } from '../lib/index.js';

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

const base = {
  schemaVersion: 2,
  attempts: [],
  status: 'running',
  phase: 'terminal',
  acceptance: 'accepted',
  watchState: 'idle',
  outcome: 'succeeded',
  deliveryState: 'ready',
  cancelState: 'none'
};

assert(taskWaitFinished(base), 'v2 phase=terminal 即使旧 status=running 也应停止等待');
assert(taskTerminalProblem(base, '图像生成') === '', '已成功且交付就绪没有终态错误');

const delivery = { ...base, deliveryState: 'failed', error: '下载中断' };
const deliveryMessage = taskTerminalProblem(delivery, '图像生成');
assert(/已成功.*交付失败/.test(deliveryMessage) && !/^图像生成失败/.test(deliveryMessage), '交付失败不伪装成生成失败', deliveryMessage);

const unknown = {
  ...base,
  acceptance: 'unknown',
  outcome: 'unknown',
  deliveryState: 'none',
  error: '响应丢失'
};
const unknownMessage = taskTerminalProblem(unknown, '图像生成');
assert(/状态未知/.test(unknownMessage), '受理未知给出人工确认语义', unknownMessage);

assert(!taskWaitFinished({ ...base, phase: 'running' }), 'v2 运行阶段继续等待');
assert(taskWaitFinished({ status: 'failed' }), '旧任务非 running 仍停止等待');
assert(/失败/.test(taskTerminalProblem({ status: 'failed', error: 'legacy' }, '图像生成')), '旧任务错误行为保持兼容');

console.log('ALL OK —— 媒体工具等待能区分 v2 成功、交付失败与状态未知');
