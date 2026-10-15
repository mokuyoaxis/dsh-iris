'use strict';

import { open } from 'node:fs/promises';
import sharp from 'sharp';

export const MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;
const TYPES = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });

function invalid(message) {
  return Object.assign(new Error(message), { code: 'IRIS_IMAGE_IMPORT_INVALID' });
}

function checkSize(size) {
  if (!size || size > MAX_IMPORT_IMAGE_BYTES) throw invalid('导入图片必须非空，且不超过20 MiB');
}

/** 只读一次有界快照；后续校验和保存使用同一份字节，不再复制变化中的源路径。 */
export async function readImportImage({ filePath, imageBytes }, signal) {
  signal.throwIfAborted();
  let bytes;
  if (filePath) {
    let file;
    try {
      file = await open(filePath, 'r');
      const stat = await file.stat();
      if (!stat.isFile()) throw invalid('导入来源必须是普通图片文件');
      checkSize(stat.size);
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!bytesRead) throw invalid('读取期间图片发生变化，请重新导入');
        offset += bytesRead;
      }
      const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
      if (extra.bytesRead) throw invalid('读取期间图片发生变化，请重新导入');
    } catch (error) {
      signal.throwIfAborted();
      if (error.code === 'IRIS_IMAGE_IMPORT_INVALID') throw error;
      throw invalid('图片无法读取，请选择可读的普通文件');
    } finally { await file?.close(); }
  } else {
    if (!(imageBytes instanceof Uint8Array)) throw invalid('导入图片内容必须是字节数据');
    checkSize(imageBytes.byteLength);
    bytes = Buffer.from(imageBytes);
  }
  signal.throwIfAborted();
  let metadata;
  try { metadata = await sharp(bytes).metadata(); }
  catch (_) {
    signal.throwIfAborted();
    throw invalid('无法读取图片，请使用有效的静态PNG、JPEG或WebP');
  }
  signal.throwIfAborted();
  const mediaType = TYPES[metadata.format];
  if (!mediaType || metadata.pages > 1 || !metadata.width || !metadata.height) {
    throw invalid('仅支持静态PNG、JPEG或WebP，不支持动画');
  }
  return { bytes, mediaType, metadata: { width: metadata.width, height: metadata.height } };
}
