// Accessible, CSP-safe clipboard helper for copying exact Core IDs using DOM text nodes only.
export async function copyTextValue(text) {
  const value = String(text || '');
  if (!value) return false;
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      // Fall through to execCommand fallback when clipboard permission is unavailable.
    }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.className = 'sr-only-copy';
  document.body.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); }
  catch (_) { copied = false; }
  finally { area.remove(); }
  return copied;
}

export function createCopyIdButton(value, { label = '复制 ID', copiedLabel = '已复制', onStatus } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet copy-id-button';
  button.textContent = label;
  button.dataset.copyId = String(value || '');
  button.setAttribute('aria-label', `${label} ${value}`);
  let timer = null;
  button.addEventListener('click', async () => {
    const ok = await copyTextValue(value);
    if (timer) clearTimeout(timer);
    if (ok) {
      button.textContent = copiedLabel;
      onStatus?.(`已复制 ${value}`);
      timer = setTimeout(() => { button.textContent = label; timer = null; }, 1600);
    } else {
      onStatus?.(`当前浏览器未授予剪贴板权限，请手动复制：${value}`, true);
    }
  });
  return button;
}
