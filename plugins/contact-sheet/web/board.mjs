const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };

export async function mount({ container, api, session, signal }) {
  const service = api.pluginOperations, urls = new Set(), timers = new Set();
  const keyName = 'iris.contact-sheet.' + session.rootId, operationId = 'community.contact-sheet.create';
  let request, selected = [], catalog, busy = false;
  const intro = element('div', '', 'intro'); intro.append(element('h2', '让灵感，并排相遇。'), element('p', '选择现有图片，离线排成一张对照板。原图保持不变。', 'muted'));
  const layout = element('div', '', 'board-layout'), choices = element('div', '', 'image-choices'), editor = element('form', '', 'card');
  choices.setAttribute('aria-label', '选择来源图片');
  const columnsLabel = element('label', '每行图片数'), columns = document.createElement('select'); columns.name = 'columns';
  for (let i = 1; i <= 4; i++) columns.add(new Option(String(i), String(i))); columns.value = '2'; columnsLabel.append(columns);
  const sizeLabel = element('label', '单张边长'), size = document.createElement('select'); size.name = 'size';
  for (const i of [128, 256, 512]) size.add(new Option(i + ' px', String(i))); size.value = '256'; sizeLabel.append(size);
  const count = element('p', '尚未选择图片', 'field-note'), submit = element('button', '制作对照板'); submit.type = 'submit'; submit.disabled = true;
  const fresh = element('button', '新建一张', 'secondary'); fresh.type = 'button'; fresh.hidden = true;
  const recover = element('button', '查询原操作', 'secondary'); recover.type = 'button'; recover.hidden = true;
  const more = element('button', '加载更多图片', 'secondary'); more.type = 'button'; more.hidden = true;
  editor.append(columnsLabel, sizeLabel, count, submit, recover, fresh, more);
  const status = element('p', '正在读取现有作品…', 'field-note'); status.setAttribute('role', 'status'); status.dataset.boardStatus = 'true';
  const output = element('section', '', 'board-result'); output.hidden = true;
  layout.append(choices, editor); container.append(intro, layout, status, output);
  function remember(value) {
    request = value;
    try { value ? sessionStorage.setItem(keyName, JSON.stringify(value)) : sessionStorage.removeItem(keyName); }
    catch (_) { status.textContent = '浏览器无法保存恢复标识；请保留本次 Operation ID。'; }
  }
  function controls() {
    const locked = busy || Boolean(request);
    submit.disabled = locked || !selected.length || !catalog?.operations.some(item => item.id === operationId && item.available);
    columns.disabled = size.disabled = locked; more.disabled = busy;
    for (const checkbox of choices.querySelectorAll('input')) checkbox.disabled = locked || !checkbox.checked && selected.length >= 16;
  }
  function note(error) { status.textContent = [error.message, error.code, error.requestId].filter(Boolean).join(' · '); }
  async function present(operation) {
    signal.throwIfAborted();
    if (operation.action !== 'plugin.execute' || operation.operationId !== operationId) throw new Error('恢复标识不属于此对照板业务，请核对业务记录');
    status.textContent = ({ queued: '已接收，正在等待处理', running: '正在排版', succeeded: '对照板已保存', interrupted: '处理已中断，保留原记录；不会自动重做', canceled: '已停止，原记录保留', failed: '处理未完成，请核对插件与授权' })[operation.state]
      + ' · ' + operation.id;
    fresh.hidden = ['queued', 'running'].includes(operation.state);
    recover.hidden = true;
    if (operation.state === 'succeeded' && operation.result.artifactIds.length) {
      const id = operation.result.artifactIds[0], blob = await api.artifact({ id, mediaType: 'image/png' }); signal.throwIfAborted();
      const url = URL.createObjectURL(blob); urls.add(url); const image = element('img'); image.src = url; image.alt = '已保存的多图对照板';
      const link = element('a', '下载原始 PNG'); link.href = url; link.download = 'iris-contact-sheet-' + id + '.png';
      output.replaceChildren(image, link); output.hidden = false;
    } else if (['queued', 'running'].includes(operation.state)) {
      const timer = setTimeout(() => { timers.delete(timer); void poll(operation.id); }, 450); timers.add(timer);
    }
  }
  async function poll(id) { try { await present((await service.inspect(id)).operation); } catch (error) { if (!signal.aborted) { note(error); recover.hidden = false; } } }
  editor.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || request || !selected.length) return;
    const contribution = catalog.operations.find(item => item.id === operationId && item.available); if (!contribution) return;
    busy = true; remember({ key: crypto.randomUUID(), operationId, dependency: contribution.dependency,
      input: { artifactIds: selected, columns: Number(columns.value), cellSize: Number(size.value) } }); controls(); status.textContent = '正在保存本次操作…';
    try { const result = await service.execute(request); await present(result.operation); }
    catch (error) { if (!signal.aborted) { note(error); status.textContent += '。请查询原操作，未自动重做。'; recover.hidden = false; } }
    finally { busy = false; if (!signal.aborted) controls(); }
  });
  fresh.addEventListener('click', () => { remember(null); output.hidden = true; output.replaceChildren(); fresh.hidden = recover.hidden = true; status.textContent = '选择图片后可以新建一次操作。'; controls(); });
  async function lookup() {
    try { await present((await service.lookup(request.key)).operation); }
    catch (error) { if (!signal.aborted) { note(error); recover.hidden = false; if (error.status === 404) fresh.hidden = false; } }
  }
  recover.addEventListener('click', () => { if (!busy && request) void lookup(); });
  signal.addEventListener('abort', () => { for (const timer of timers) clearTimeout(timer); for (const url of urls) URL.revokeObjectURL(url); }, { once: true });
  if (!service) { status.textContent = '此服务未开启插件业务执行。'; return; }
  catalog = await service.catalog({ limit: '30' }); signal.throwIfAborted();
  async function appendImages(page) { for (const artifact of page.artifacts) {
    const label = element('label', '', 'image-choice'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = artifact.id;
    const image = element('img'); image.alt = '来源图片 ' + artifact.id;
    label.append(checkbox, image, element('span', artifact.id.slice(-8), 'muted')); choices.append(label);
    const blob = await api.artifact({ id: artifact.id, mediaType: artifact.mediaType }); signal.throwIfAborted();
    const url = URL.createObjectURL(blob); urls.add(url); image.src = url;
    checkbox.addEventListener('change', () => { selected = checkbox.checked ? [...selected, artifact.id] : selected.filter(id => id !== artifact.id);
      count.textContent = '已选择 ' + selected.length + ' 张 · 按选择顺序排版'; controls(); });
  } more.hidden = page.nextOffset === null || page.nextOffset === undefined; controls(); }
  more.addEventListener('click', async () => {
    if (busy || catalog.nextOffset === null) return;
    busy = true; controls();
    try { catalog = await service.catalog({ limit: '30', offset: String(catalog.nextOffset) }); signal.throwIfAborted(); await appendImages(catalog); }
    catch (error) { if (!signal.aborted) note(error); }
    finally { busy = false; if (!signal.aborted) controls(); }
  });
  await appendImages(catalog);
  if (!catalog.artifacts.length) choices.append(element('p', '当前没有可用图片，请先通过现有创作入口或 CLI 导入。', 'muted'));
  status.textContent = '最多选择 16 张图片，不调用模型。';
  try { const saved = sessionStorage.getItem(keyName); if (saved) request = JSON.parse(saved); }
  catch (_) { status.textContent = '原恢复标识无法读取，请先核对业务记录。'; }
  if (request) await lookup();
  controls();
  return () => { for (const timer of timers) clearTimeout(timer); for (const url of urls) URL.revokeObjectURL(url); container.replaceChildren(); };
}
