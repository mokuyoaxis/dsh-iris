export async function mount(context) {
  const { container, artifact, api, signal, theme } = context;
  const evidence = window.__panelPlugin ??= { contexts: [], events: [] }; evidence.contexts.push(context); evidence.events.push('png:mount');
  const bytes = await api.artifact(artifact); signal.throwIfAborted();
  const image = new Image(), url = URL.createObjectURL(bytes);
  image.src = url; image.alt = '扩展读取的原始作品';
  try { await image.decode(); signal.throwIfAborted(); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  const caption = document.createElement('p'); caption.dataset.previewInfo = 'true';
  caption.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · ' + bytes.size + ' bytes';
  const update = value => { container.dataset.theme = value.mode; }; update(theme.current()); const unsubscribe = theme.subscribe(update);
  container.append(image, caption); container.dataset.artifact = artifact.id;
  evidence.preview = { id: artifact.id, size: bytes.size, mediaType: bytes.type };
  return () => { unsubscribe(); URL.revokeObjectURL(url); image.removeAttribute('src'); container.replaceChildren(); evidence.events.push('png:cleanup'); };
}
