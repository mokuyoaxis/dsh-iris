export const DEFAULT_APPEARANCE = Object.freeze({ contractVersion: 0, theme: 'light', accent: 'iris', density: 'comfortable',
  position: 'center', overlay: 86, blur: 0 });
const KEY = 'iris.panel.appearance.v0';
export function normalizeAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.contractVersion !== 0
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_APPEARANCE, key))
    || !['light', 'dark', 'system'].includes(value.theme) || !['iris', 'violet', 'rose', 'apricot'].includes(value.accent)
    || !['comfortable', 'compact'].includes(value.density) || !['center', 'top', 'bottom'].includes(value.position)
    || !Number.isInteger(value.overlay) || value.overlay < 50 || value.overlay > 100
    || !Number.isInteger(value.blur) || value.blur < 0 || value.blur > 20) throw new TypeError('外观文件格式或版本不支持');
  return { ...value, accent: 'iris' };
}

export function createAppearance() {
  const $ = id => document.getElementById(id), root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preferences = { ...DEFAULT_APPEARANCE }, backgroundUrl, pictureTicket = 0, backgroundReady = false;
  const note = (text, error = false) => { $('appearance-note').textContent = text; $('appearance-note').classList.toggle('error', error); };
  function apply() {
    const dark = preferences.theme === 'dark' || preferences.theme === 'system' && system.matches;
    root.dataset.theme = dark ? 'dark' : 'light'; root.dataset.accent = preferences.accent; root.dataset.density = preferences.density;
    root.style.setProperty('--background-position', preferences.position);
    root.style.setProperty('--background-opacity', String((100 - preferences.overlay) / 100));
    root.style.setProperty('--background-blur', preferences.blur + 'px');
    for (const key of ['theme', 'density', 'position', 'overlay', 'blur']) $('appearance-' + key).value = String(preferences[key]);
    $('appearance-overlay-value').textContent = preferences.overlay + '%'; $('appearance-blur-value').textContent = preferences.blur + ' px';
  }
  function save() {
    apply();
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); note('已保存到此浏览器，即时生效。'); }
    catch (_) { note('此浏览器无法保存外观，本次预览仍有效。', true); }
  }
  async function storedPicture(action, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('iris.panel.appearance', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('images');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('images', action === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('images');
        const request = action === 'get' ? store.get('background') : action === 'put' ? store.put(value, 'background') : store.delete('background');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('外观存储已中断'));
      });
    } finally { db.close(); }
  }
  function replacePicture(url) {
    if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
    backgroundUrl = url;
    root.style.setProperty('--workspace-image', url ? 'url("' + url + '")' : 'none');
    $('appearance-remove').disabled = !url;
    $('appearance-image-note').textContent = url ? '已使用本地背景，仅保存在此浏览器。' : '没有自选背景。图片不会上传到 Core。';
  }
  async function validatePicture(file) {
    if (!(file instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new TypeError('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 图片');
    const url = URL.createObjectURL(file), image = new Image();
    try { image.src = url; await image.decode(); if (image.naturalWidth > 16384 || image.naturalHeight > 16384) throw new TypeError('背景图片尺寸过大'); return url; }
    catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) preferences = normalizeAppearance(JSON.parse(saved));
  } catch (_) { note('已使用默认外观；原偏好不可读取或版本不支持。', true); }
  apply();
  void (async () => {
    const ticket = pictureTicket;
    try {
      const file = await storedPicture('get');
      if (file) { const url = await validatePicture(file); if (ticket === pictureTicket) replacePicture(url); else URL.revokeObjectURL(url); }
    } catch (_) { note('本地背景无法读取，配色仍可使用。可重新选择图片。', true); }
    finally { backgroundReady = true; $('appearance-image').disabled = false; }
  })();
  $('appearance-open').addEventListener('click', () => $('appearance-dialog').showModal());
  $('appearance-close').addEventListener('click', () => $('appearance-dialog').close());
  for (const key of ['theme', 'density', 'position', 'overlay', 'blur']) $('appearance-' + key).addEventListener('input', event => {
    preferences[key] = ['overlay', 'blur'].includes(key) ? Number(event.target.value) : event.target.value; save();
  });
  system.addEventListener('change', () => { if (preferences.theme === 'system') apply(); });
  $('appearance-image').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file || !backgroundReady) return;
    const ticket = ++pictureTicket; $('appearance-image').disabled = true; note('正在保存本地背景…');
    try {
      const url = await validatePicture(file);
      if (ticket !== pictureTicket) { URL.revokeObjectURL(url); return; }
      replacePicture(url);
      $('appearance-remove').disabled = true;
      try { await storedPicture('put', file); note('背景已保存到此浏览器。'); }
      catch (_) { note('背景存储不可用，本次预览仍有效；刷新后需重新选择。', true); }
    } catch (error) { note(error.message, true); }
    finally { event.target.value = ''; $('appearance-image').disabled = false; $('appearance-remove').disabled = !backgroundUrl; }
  });
  $('appearance-remove').addEventListener('click', async () => {
    ++pictureTicket; replacePicture(null);
    try { await storedPicture('delete'); note('已移除此浏览器的背景。'); }
    catch (_) { note('背景预览已移除，但本地存储更新失败；刷新后请核对。', true); }
  });
  $('appearance-reset').addEventListener('click', () => { preferences = { ...DEFAULT_APPEARANCE }; save(); });
  $('appearance-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(preferences, null, 2) + '\n'], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'iris-theme.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('appearance-import').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 16384) throw new TypeError('外观文件过大'); preferences = normalizeAppearance(JSON.parse(await file.text())); save(); }
    catch (_) { note('外观文件格式或版本不支持；当前设置已保留。', true); }
    finally { event.target.value = ''; }
  });
  window.addEventListener('pagehide', () => { ++pictureTicket; if (backgroundUrl) URL.revokeObjectURL(backgroundUrl); });
}
