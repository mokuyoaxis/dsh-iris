'use strict';
/** 单图业务只消费显式字节和 Model Ports，不读取 Host/配置或保存产物。 */
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelErrorRecord, modelPortSnapshot } from './model-port-contract.js';

export const VISION_BUDGET = Object.freeze({ timeoutMs: 120000, maxInputTextBytes: 32768,
  maxOutputChars: 6000, maxImageBytes: 20 * 1024 * 1024 });
export const VISION_CANDIDATE_POLICY = Object.freeze({ skipUnavailable: true, allowRejected: true, allowEmptyResult: true });

export async function completeVision(ports, request, { signal, operation, budget = VISION_BUDGET } = {}) {
  if (!Array.isArray(ports) || !ports.length) throw new ModelPortError('IRIS_MODEL_UNAVAILABLE');
  const op = operation || createModelOperation({ signal, budget: { timeoutMs: budget.timeoutMs, maxInvocations: ports.length } });
  const errors = [];
  const observed = ports.map(port => {
    let diagnosed = false;
    return {
      describe() {
        const descriptor = modelPortSnapshot(port);
        if (!diagnosed && descriptor.availability !== 'available') {
          errors.push(modelErrorRecord(new ModelPortError(descriptor.reasonCode, { stage: 'prepare', backendId: descriptor.identity.backendId })));
          diagnosed = true;
        }
        return descriptor;
      },
      async complete(input, options) {
        try { return await port.complete(input, options); }
        catch (error) {
          errors.push({ ...modelErrorRecord(error), backendId: modelPortSnapshot(port).identity.backendId });
          throw error;
        }
      }
    };
  });
  try {
    const result = await op.runCandidates(observed, request, { budget }, VISION_CANDIDATE_POLICY);
    return Object.freeze({ ...result, errors: Object.freeze([...errors]) });
  } catch (error) {
    // 受控记录供入口写健康反馈，不包含原始错误/图片/问题。
    if (error instanceof ModelPortError) error.errors = Object.freeze([...errors]);
    throw error;
  } finally { if (!operation) op.dispose(); }
}
