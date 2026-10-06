'use strict';
/** 视频输入按候选准备；短期地址和本地路径不落 Task。 */
import fs from 'node:fs';
import path from 'node:path';
import { GenerationInputError } from './generation-input.js';
import { parseModelRef } from './models.js';
import { prepareProviderInput } from './provider-adapter.js';
import { ProviderContractError } from './provider-contract.js';

export function videoTaskCandidates(candidates, normalized) {
  const s2v = normalized.videoMode === 's2v';
  const compatible = candidates.filter(candidate => /s2v/i.test(parseModelRef(candidate.model)?.modelId || '') === s2v);
  if (!compatible.length) throw new GenerationInputError(s2v
    ? 'audio_path 只能配合 s2v 数字人模型' : 's2v 模型需要首帧和音频输入');
  return compatible.map(candidate => ({ ...candidate,
    ...(normalized.firstFramePath ? { async prepareInput({ signal }) {
      if (signal.aborted) throw new ProviderContractError('视频输入准备已取消', { stage: 'prepare', category: 'aborted', acceptance: 'not_accepted' });
      if (s2v) {
        const model = parseModelRef(candidate.model).modelId;
        const image = await prepareProviderInput(candidate.adapter, { model, filePath: normalized.firstFramePath, signal });
        if (signal.aborted) throw new ProviderContractError('视频输入准备已取消', { stage: 'upload', category: 'aborted', acceptance: 'not_accepted' });
        const audio = await prepareProviderInput(candidate.adapter, { model, filePath: normalized.audioPath, signal });
        return { ...normalized.providerInput, imgDataUrl: image.url, audioUrl: audio.url };
      }
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(normalized.firstFramePath).toLowerCase()];
      if (!mime) throw new ProviderContractError('首帧格式不受支持', { stage: 'prepare', category: 'invalid_request', acceptance: 'not_accepted' });
      return { ...normalized.providerInput, imgDataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(normalized.firstFramePath).toString('base64') };
    } } : {})
  }));
}
