// Explicit, store-only application surface; no Provider, scheduling loop or HTTP ownership.
import { initializeExecutionRoot, inspectExecutionRoot, acceptOperation, transitionOperation,
  readOperation, operationId, listOperations, projectOperation, operationFail } from './operation-store.js';

export function createLocalOperationService(runtime) {
  function execute(name, input) {
    const readOnly = ['operation.inspect', 'operation.lookup', 'operation.list'].includes(name);
    return runtime.run(readOnly ? 'inspect' : 'execute', ({ dataRoot, signal }) => {
      signal.throwIfAborted();
      if (name === 'execution.init') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['imageGeneration', 'audio'].includes(key))
            || ['imageGeneration', 'audio'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')) operationFail('IRIS_OPERATION_INPUT_INVALID', 'execution.init 只接受可选 imageGeneration/audio 开关');
        return { contractVersion: 0, root: initializeExecutionRoot(dataRoot, input), executionEnabled: false };
      }
      if (name === 'operation.accept') {
        const result = acceptOperation(dataRoot, input);
        return { contractVersion: 0, operation: projectOperation(result.operation), idempotentReplay: result.idempotentReplay };
      }
      if (name === 'operation.transition') return { contractVersion: 0, operation: projectOperation(transitionOperation(dataRoot, input)) };
      if (name === 'operation.list') {
        const result = listOperations(dataRoot, input);
        return { contractVersion: 0, ...result, operations: result.operations.map(projectOperation) };
      }
      if (name === 'operation.inspect' || name === 'operation.lookup') {
        const key = name === 'operation.inspect' ? 'id' : 'key';
        if (!input || Object.keys(input).length !== 1 || typeof input[key] !== 'string') operationFail('IRIS_OPERATION_INPUT_INVALID', '需要单个 Operation ID 或请求 Key');
        const marker = inspectExecutionRoot(dataRoot), id = key === 'id' ? input.id : operationId(marker, input.key);
        const record = readOperation(dataRoot, id, marker);
        if (!record) operationFail('IRIS_OPERATION_NOT_FOUND', 'Operation 不存在');
        return { contractVersion: 0, operation: projectOperation(record) };
      }
      throw new TypeError('未知 Operation 存储操作');
    });
  }
  return Object.freeze({ execute });
}
