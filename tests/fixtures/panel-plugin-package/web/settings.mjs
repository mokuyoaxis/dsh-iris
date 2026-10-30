export async function mount(context) {
  const { api, container, signal } = context;
  const evidence = window.__panelPlugin ??= { contexts: [], events: [] }; evidence.contexts.push(context); evidence.events.push('settings:mount');
  const status = document.createElement('p'); status.dataset.settingsStatus = 'true'; container.append(status);
  if (!api.providers) { status.textContent = '此会话未开启供应商设置'; return; }
  let settings = await api.providers.read(); signal.throwIfAborted();
  const form = document.createElement('form'), label = document.createElement('label'), input = document.createElement('input'), save = document.createElement('button');
  input.name = 'name'; input.required = true; input.value = settings.providers[0]?.name || 'Fixture service'; label.textContent = '服务名称'; label.append(input);
  save.type = 'submit'; save.textContent = '保存服务名称'; form.append(label, save); container.prepend(form); status.textContent = '设置已读取';
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    try {
      const provider = settings.providers[0], value = { id: provider?.id || 'fixture', name: input.value,
        baseUrl: provider?.baseUrl || 'http://127.0.0.1:9/v1', mediaBaseUrl: provider?.mediaBaseUrl || '',
        mediaProtocol: provider?.mediaProtocol || 'openai-images', auth: provider?.auth || 'none', enabled: false,
        models: (provider?.models || []).map(model => ({ id: model.id, capabilities: model.capabilities, imageProtocol: model.imageProtocol || 'auto', musicProtocol: model.musicProtocol || '' })) };
      settings = await api.providers.save({ expectedRevision: settings.revision, provider: value, credential: { action: 'keep' }, assignments: {} });
      signal.throwIfAborted(); status.textContent = '已保存 · ' + settings.providers[0].name;
    } catch (error) { if (!signal.aborted) status.textContent = error.code + ' · ' + error.message; }
    finally { if (!signal.aborted) save.disabled = false; }
  });
  return () => { container.replaceChildren(); evidence.events.push('settings:cleanup'); };
}
