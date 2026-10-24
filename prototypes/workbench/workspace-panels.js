import { presentFlow } from './view-model.js';

// A finite UI fixture, not grants or a configuration accepted by Core.
export const DEMO_CONNECTION_TOOLS = Object.freeze([
  ['connection', 'read', false], ['models', 'read', true], ['runs', 'read', true], ['run', 'read', true],
  ['import_image', 'create', true], ['create_run', 'create', true], ['continue', 'execute', true],
  ['operation', 'read', true], ['lookup', 'read', true], ['stop', 'stop', true], ['image', 'read', true], ['connections', 'read', false]
].map(([name, scope, image]) => Object.freeze({ name: 'iris_core_' + name, scope, image })));
export function previewDraftTools(image, scopes) {
  return DEMO_CONNECTION_TOOLS.filter(tool => (!tool.image || image) && scopes.includes(tool.scope));
}

const $ = id => document.getElementById(id);
const node = (tag, text = '', className) => { const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value; };
const SAMPLE = './assets/sample.webp';

export function createWorkspacePanels({ list, inspect, sourceFor, openRun, newRun, feedback }) {
  let filter = 'all', busy = false, uploading = false, page = 'studio', draftId = null, serial = 0;
  const drafts = new Map();
  function show(next) {
    page = next;
    for (const name of ['studio', 'gallery', 'connections']) {
      $(name + '-page').hidden = name !== page;
      const button = $('nav-' + name); if (name === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    $('page-location').textContent = { studio: '创作', gallery: '作品', connections: '连接' }[page];
    feedback(''); window.scrollTo(0, 0);
  }
  function thumbnail(view) {
    const output = view.selection && view.selection.artifactId === view.output?.artifactId;
    return { url: output ? SAMPLE : sourceFor(view.source.artifactId).url, alt: output ? '已选择的内置示例结果' : '此流程的原图预览' };
  }
  function update({ busy: nextBusy, uploading: nextUploading }) {
    busy = nextBusy; uploading = nextUploading;
    const entries = list().map((entry, index) => ({ view: inspect(entry.id), index: index + 1 })).reverse();
    for (const id of ['gallery-count', 'recent-count']) $(id).textContent = String(entries.length);
    $('global-status').textContent = busy ? '演示进行中' : '本地演示';
    $('recent-empty').hidden = Boolean(entries.length);
    $('recent-list').replaceChildren(...entries.slice(0, 6).map(({ view, index }) => {
      const button = node('button', '', 'recent-item'), image = document.createElement('img'), text = node('span');
      const preview = thumbnail(view); image.src = preview.url; image.alt = ''; button.type = 'button'; button.disabled = busy || uploading;
      text.append(node('strong', '图片编辑 ' + String(index).padStart(2, '0')), node('small', presentFlow(view).title));
      button.append(image, text); button.addEventListener('click', () => openRun(view.id)); return button;
    }));
    const filtered = entries.filter(({ view }) => filter === 'all' || (filter === 'selected' ? Boolean(view.selection) : !view.selection));
    $('gallery-summary').textContent = filtered.length + ' 个演示流程'; $('gallery-empty').hidden = Boolean(filtered.length);
    $('gallery-empty-title').textContent = entries.length ? '当前筛选下还没有流程。' : '让第一张作品，在这里发生。';
    $('gallery-empty-message').textContent = entries.length ? '试试其他筛选，或开始新的创作演示。' : '在创作页开始一次演示，流程就会出现在这里。刷新整页会清空演示记录。';
    $('gallery-grid').replaceChildren(...filtered.map(({ view, index }) => {
      const button = node('button', '', 'gallery-card'), image = document.createElement('img'), content = node('div', '', 'gallery-card-content');
      const preview = thumbnail(view); image.src = preview.url; image.alt = preview.alt; button.type = 'button'; button.dataset.runId = view.id; button.disabled = busy || uploading;
      const meta = node('div', '', 'gallery-card-meta'); meta.append(node('span', presentFlow(view).title), node('span', '演示 · 本标签页'));
      content.append(node('strong', '图片编辑 ' + String(index).padStart(2, '0')), node('p', view.input.prompt), meta);
      button.append(image, content); button.addEventListener('click', () => openRun(view.id)); return button;
    }));
    for (const id of ['gallery-create', 'gallery-empty-create']) $(id).disabled = busy || uploading;
  }
  function draftTools() {
    const image = $('draft-image').checked, scopes = [...document.querySelectorAll('#draft-scopes input:checked')].map(input => input.value);
    const tools = previewDraftTools(image, scopes);
    $('draft-tool-count').textContent = tools.length + ' 个';
    $('draft-tool-list').replaceChildren(...tools.map(tool => node('li', tool.name)));
    return { image, scopes, tools: tools.map(tool => tool.name) };
  }
  function renderDrafts() {
    for (const id of ['draft-count', 'draft-list-count']) $(id).textContent = String(drafts.size);
    $('draft-empty').hidden = Boolean(drafts.size);
    $('draft-list').replaceChildren(...[...drafts.values()].map(draft => {
      const button = node('button', '', 'draft-item'); button.type = 'button'; button.setAttribute('aria-current', String(draft.id === draftId));
      button.append(node('strong', draft.label), node('small', '演示草稿 · ' + draft.tools.length + ' 个工具'));
      button.addEventListener('click', () => {
        draftId = draft.id; $('draft-name').value = draft.label; $('draft-image').checked = draft.image;
        for (const input of document.querySelectorAll('#draft-scopes input')) input.checked = draft.scopes.includes(input.value);
        draftTools(); renderDrafts(); feedback('已读取演示草稿，没有连接客户端或改变授权。');
      }); return button;
    }));
  }
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => show(button.dataset.page)));
  for (const id of ['gallery-create', 'gallery-empty-create']) $(id).addEventListener('click', newRun);
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const item of document.querySelectorAll('[data-filter]')) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }
    update({ busy, uploading });
  }));
  $('draft-form').addEventListener('change', draftTools);
  $('draft-form').addEventListener('submit', event => {
    event.preventDefault(); const label = $('draft-name').value.trim();
    if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) { feedback('请输入 1–80 字符的连接名称。', true); $('draft-name').focus(); return; }
    draftId ||= 'draft-' + (++serial);
    drafts.set(draftId, { id: draftId, label, ...draftTools() }); renderDrafts();
    feedback('演示草稿已保存，仅保存在本标签页；没有创建真实 Core 授权。');
  });
  $('draft-new').addEventListener('click', () => {
    draftId = null; $('draft-form').reset(); $('draft-tools').open = false; draftTools(); renderDrafts(); $('draft-name').focus(); feedback('已准备新草稿，现有演示草稿保留。');
  });
  draftTools(); renderDrafts();
  return Object.freeze({ show, update });
}
