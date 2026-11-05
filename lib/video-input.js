'use strict';
/** 视频输入按候选准备；短期地址和本地路径不落 Task。 */
import fs from 'node:fs';
import path from 'node:path';
import { GenerationInputError } from './generation-input.js';
import { parseModelRef } from './models.js';
import { prepareProviderInput } from './provider-adapter.js';
import { ProviderContractError } from './provider-contract.js';

/** Recognized input families constrain routing; opaque compatible IDs keep their existing t2v/i2v support. */
export function videoModelSupportsMode(modelId, mode) {
  const family = /(?:^|[-_.])(t2v|i2v|s2v|r2v)(?=$|[-_.])/i.exec(modelId)?.[1].toLowerCase();
  if (family) return family === mode;
  return mode === 't2v' || mode === 'i2v';
}

export function videoTaskCandidates(candidates, normalized) {
  const s2v = normalized.videoMode === 's2v';
  const compatible = candidates.filter(candidate => videoModelSupportsMode(parseModelRef(candidate.model)?.modelId || '', normalized.videoMode));
  if (!compatible.length) throw new GenerationInputError(s2v
    ? 'audio_path 只能配合 s2v 数字人模型' : '没有与 ' + normalized.videoMode + ' 输入匹配的视频模型；s2v 模型需要首帧和音频输入');
  return compatible.map(candidate => ({ ...candidate,
    ...(normalized.firstFramePath ? { async prepareInput({ signal, taskId, attemptId, networkBudget, recordNetworkRoute }) {
      if (signal.aborted) throw new ProviderContractError('视频输入准备已取消', { stage: 'prepare', category: 'aborted', acceptance: 'not_accepted' });
      if (s2v) {
        const model = parseModelRef(candidate.model).modelId;
        const image = await prepareProviderInput(candidate.adapter, { model, filePath: normalized.firstFramePath, signal }, { taskId, attemptId, networkBudget, recordNetworkRoute });
        if (signal.aborted) throw new ProviderContractError('视频输入准备已取消', { stage: 'upload', category: 'aborted', acceptance: 'not_accepted' });
        const audio = await prepareProviderInput(candidate.adapter, { model, filePath: normalized.audioPath, signal }, { taskId, attemptId, networkBudget, recordNetworkRoute });
        return { ...normalized.providerInput, imgDataUrl: image.url, audioUrl: audio.url };
      }
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(normalized.firstFramePath).toLowerCase()];
      if (!mime) throw new ProviderContractError('首帧格式不受支持', { stage: 'prepare', category: 'invalid_request', acceptance: 'not_accepted' });
      return { ...normalized.providerInput, imgDataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(normalized.firstFramePath).toString('base64') };
    } } : {})
  }));
}
