const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export async function mount({ container, api, session, dependency, signal: parentSignal, theme }) {
  const lifetime = new AbortController(), signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const service = api.pluginOperations, urls = new Set();
  const operationId = dependency.pluginId + '.create';
  const storageKey = operationId + ':' + session.rootId;
  let receipt, selected = [], catalog, busy = false, timer, renderedId, unsubscribe, closed = false;
  function cleanup() {
    if (closed) return;
    closed = true; lifetime.abort(); clearTimeout(timer); unsubscribe?.();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); container.replaceChildren();
  }
  signal.addEventListener('abort', cleanup, { once: true });
  const intro = element('header', '', 'starter-intro');
  intro.append(element('span', 'LOCAL · NO MODEL CALLS', 'starter-eyebrow'), element('h2', '让灵感，并排相遇。'),
    element('p', '选择图片，制作一张属于你的灵感对照板。', 'muted'));
  const layout = element('div', '', 'starter-layout'), choices = element('div', '', 'starter-choices');
  choices.setAttribute('aria-label', '选择来源图片');
  const editor = element('form', '', 'starter-editor');
  const columnsLabel = element('label', '每行图片数'), columns = document.createElement('select'); columns.name = 'columns';
  for (let i = 1; i <= 4; i++) columns.add(new Option(String(i), String(i)));
  columns.value = '2'; columnsLabel.append(columns);
  const sizeLabel = element('label', '单张边长'), size = document.createElement('select'); size.name = 'size';
  for (const n of [128, 256, 512]) size.add(new Option(n + ' px', String(n)));
  size.value = '256'; sizeLabel.append(size);
  const count = element('p', '尚未选择图片', 'muted'), submit = element('button', '制作对照板');
  submit.type = 'submit'; submit.disabled = true;
  const recover = element('button', '查询原操作', 'secondary'); recover.type = 'button'; recover.hidden = true;
  const fresh = element('button', '新建一张', 'secondary'); fresh.type = 'button'; fresh.hidden = true;
  const more = element('button', '加载更多图片', 'secondary'); more.type = 'button'; more.hidden = true;
  const details = element('details'), summary = element('summary', '使用说明');
  details.append(summary, element('p', '按选择顺序排版，最多 16 张。作品保存在 Core；刷新只查询原操作，不会自动重新制作。', 'muted'));
  editor.append(columnsLabel, sizeLabel, count, submit, recover, fresh, more, details);
  const status = element('p', '正在读取现有图片…', 'starter-status');
  status.setAttribute('role', 'status');
  const output = element('section', '', 'starter-result'); output.hidden = true;
  layout.append(choices, editor); container.append(intro, layout, status, output);
  function remember(value) {
    value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey);
    receipt = value;
  }
  function controls() {
    const locked = busy || Boolean(receipt);
    submit.disabled = locked || !selected.length || !catalog?.operations.some(item => item.id === operationId && item.available);
    columns.disabled = size.disabled = locked; more.disabled = busy;
    for (const checkbox of choices.querySelectorAll('input')) checkbox.disabled = locked || !checkbox.checked && selected.length >= 16;
  }
  function note(error) { status.textContent = [error.message, error.code, error.requestId].filter(Boolean).join(' · '); }
  async function present(operation) {
    signal.throwIfAborted();
    if (operation.action !== 'plugin.execute' || operation.operationId !== operationId) throw new Error('此恢复标识属于另一项业务，请到业务记录核对。');
    status.textContent = ({ queued: '已接收，等待处理', running: '正在排版', succeeded: '对照板已保存',
      interrupted: '操作已中断，不会自动重做', canceled: '已停止，记录保留', failed: '操作未完成，请查看业务记录' })[operation.state] + ' · ' + operation.id;
    fresh.hidden = ['queued', 'running'].includes(operation.state); recover.hidden = true;
    if (operation.state === 'succeeded' && renderedId !== operation.id) {
      const id = operation.result.artifactIds[0];
      const blob = await api.artifact({ id, mediaType: 'image/png' }, { signal }); signal.throwIfAborted();
      const url = URL.createObjectURL(blob); urls.add(url);
      const image = element('img'); image.src = url; image.alt = '已保存的灵感对照板';
      const link = element('a', '下载原始 PNG'); link.href = url; link.download = 'iris-board-' + id + '.png';
      output.replaceChildren(image, link); output.hidden = false; renderedId = operation.id;
    } else if (['queued', 'running'].includes(operation.state)) {
      clearTimeout(timer); timer = setTimeout(() => { void poll(operation.id); }, 450);
    }
  }
  async function poll(id) {
    try { await present((await service.inspect(id, { signal })).operation); }
    catch (error) { if (!signal.aborted) { note(error); recover.hidden = false; } }
  }
  async function lookup() {
    if (busy || !receipt) return;
    busy = true; controls();
    try { await present((await service.lookup(receipt.key, { signal })).operation); }
    catch (error) { if (!signal.aborted) { note(error); recover.hidden = false; if (error.status === 404) fresh.hidden = false; } }
    finally { busy = false; if (!signal.aborted) controls(); }
  }
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || receipt || !selected.length) return;
    const contribution = catalog.operations.find(item => item.id === operationId && item.available);
    if (!contribution) return;
    busy = true;
    // Save the UUID before submitting. Recovery only looks up this UUID.
    try { remember({ key: crypto.randomUUID() }); }
    catch { busy = false; status.textContent = '浏览器无法保存恢复标识，本次未提交。请允许会话存储后再试。'; controls(); return; }
    controls();
    status.textContent = '正在保存本次操作 · ' + receipt.key;
    try {
      const accepted = await service.execute({ key: receipt.key, operationId, dependency: contribution.dependency,
        input: { artifactIds: [...selected], columns: Number(columns.value), cellSize: Number(size.value) } }, { signal });
      await present(accepted.operation);
    } catch (error) {
      if (!signal.aborted) { note(error); status.textContent += '。请查询原操作；未自动重做。'; recover.hidden = false; }
    } finally { busy = false; if (!signal.aborted) controls(); }
  }, { signal });
  recover.addEventListener('click', () => { void lookup(); }, { signal });
  fresh.addEventListener('click', () => {
    if (busy) return;
    try { remember(null); }
    catch { status.textContent = '无法清除恢复标识，原操作保留；请先检查浏览器存储。'; return; }
    renderedId = undefined; output.hidden = true; output.replaceChildren();
    // Only keep URLs that still back source thumbnails.
    const thumbnails = new Set([...choices.querySelectorAll('img')].map(image => image.src));
    for (const url of urls) if (!thumbnails.has(url)) { URL.revokeObjectURL(url); urls.delete(url); }
    fresh.hidden = recover.hidden = true; status.textContent = '选择图片后，可以新建一次操作。'; controls();
  }, { signal });
  async function appendImages(page) {
    for (const artifact of page.artifacts) {
      const label = element('label', '', 'starter-choice'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = artifact.id;
      const image = element('img'); image.alt = '来源图片 ' + artifact.id;
      label.append(checkbox, image, element('span', artifact.id.slice(-8), 'muted')); choices.append(label);
      const blob = await api.artifact({ id: artifact.id, mediaType: artifact.mediaType }, { signal }); signal.throwIfAborted();
      const url = URL.createObjectURL(blob); urls.add(url); image.src = url;
      checkbox.addEventListener('change', () => {
        selected = checkbox.checked ? [...selected, artifact.id] : selected.filter(id => id !== artifact.id);
        count.textContent = '已选择 ' + selected.length + ' 张 · 按选择顺序排版'; controls();
      }, { signal });
    }
    more.hidden = page.nextOffset === null || page.nextOffset === undefined; controls();
  }
  more.addEventListener('click', async () => {
    if (busy || catalog.nextOffset === null) return;
    busy = true; controls();
    try {
      catalog = await service.catalog({ limit: '30', offset: String(catalog.nextOffset) }, { signal });
      signal.throwIfAborted(); await appendImages(catalog);
    } catch (error) { if (!signal.aborted) note(error); }
    finally { busy = false; if (!signal.aborted) controls(); }
  }, { signal });
  try {
    signal.throwIfAborted();
    const updateTheme = value => { container.dataset.theme = value.mode; };
    updateTheme(theme.current()); unsubscribe = theme.subscribe(updateTheme);
    if (!service) { status.textContent = '此服务尚未启用插件业务执行，请核对启动配置。'; return cleanup; }
    catalog = await service.catalog({ limit: '30' }, { signal }); signal.throwIfAborted();
    await appendImages(catalog);
    status.textContent = catalog.artifacts.length ? '选择图片即可开始，不调用模型。' : '还没有图片。请先通过创作页或 CLI 导入。';
    let saved;
    try { saved = sessionStorage.getItem(storageKey); }
    catch { status.textContent = '无法读取浏览器恢复标识，请到业务记录查看已有操作。'; }
    if (saved) {
      try {
        receipt = JSON.parse(saved);
        if (!receipt || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(receipt.key)) throw new Error('invalid receipt');
      } catch {
        receipt = { invalid: true }; status.textContent = '浏览器恢复标识损坏，请核对业务记录后点击新建。'; fresh.hidden = false;
      }
      if (!receipt.invalid) await lookup();
    }
    controls(); return cleanup;
  } catch (error) { cleanup(); throw error; }
}
