export async function mount({ container, artifact, api, signal: parentSignal, theme }) {
  const lifetime = new AbortController(), signal = AbortSignal.any([parentSignal, lifetime.signal]);
  let url, unsubscribe, closed = false;
  const image = new Image(); image.alt = 'Core 中保存的原始 PNG';
  function cleanup() {
    if (closed) return;
    closed = true; lifetime.abort(); unsubscribe?.();
    if (url) URL.revokeObjectURL(url);
    image.removeAttribute('src'); container.replaceChildren();
  }
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    const bytes = await api.artifact(artifact, { signal }); signal.throwIfAborted();
    url = URL.createObjectURL(bytes); image.src = url;
    await image.decode(); signal.throwIfAborted();
    const caption = document.createElement('p'); caption.className = 'muted';
    caption.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · ' + bytes.size.toLocaleString() + ' bytes';
    const update = value => { container.dataset.theme = value.mode; };
    update(theme.current()); unsubscribe = theme.subscribe(update);
    container.classList.add('starter-preview'); container.append(image, caption);
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
