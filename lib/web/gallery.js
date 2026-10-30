const $ = selector => document.querySelector(selector);
const element = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };

/** Read-only gallery. Preview bytes are fetched only while a card is visible. */
export function createGallery({ openRun, describe }) {
  let client, visible = false, filter = 'all', kind = 'image', audioEnabled = false, cursor = null, busy = false, ticket = 0, controller, observer, activeAudio;
  const previews = new Map();
  function clearAudio() {
    if (!activeAudio) return;
    activeAudio.controller.abort(); activeAudio.player.pause(); activeAudio.player.removeAttribute('src'); activeAudio.player.load(); activeAudio.player.hidden = true;
    if (activeAudio.url) URL.revokeObjectURL(activeAudio.url);
    activeAudio.button.disabled = false; activeAudio.button.hidden = false; activeAudio = null;
  }
  function clear() {
    controller?.abort(); observer?.disconnect(); observer = null;
    clearAudio();
    for (const item of previews.values()) { item.controller.abort(); if (item.url) URL.revokeObjectURL(item.url); }
    previews.clear();
  }
  function observe() {
    observer?.disconnect();
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const item = previews.get(entry.target); if (!item) continue;
        if (!entry.isIntersecting) continue;
        if (item.url || item.loading) continue;
        const at = ticket, http = client, job = item.controller = new AbortController(); item.loading = true;
        void http.get('/api/v0/artifacts/' + item.artifactId + '/content', { binary: true, signal: job.signal }).then(async blob => {
          if (!visible || at !== ticket || job.signal.aborted) return;
          item.url = URL.createObjectURL(blob); item.image.src = item.url; await item.image.decode();
          if (!visible || at !== ticket || job.signal.aborted) return;
          item.image.hidden = false; item.marker.hidden = true;
        }).catch(error => {
          if (!job.signal.aborted && at === ticket) item.marker.textContent = '预览暂不可用';
        }).finally(() => { if (item.controller === job) item.loading = false; });
      }
    });
    for (const card of previews.keys()) observer.observe(card);
  }
  function card(run) {
    if (['speech/v0', 'transcribe/v0'].includes(run.recipe)) return audioCard(run);
    const button = element('button', '', 'gallery-card'); button.type = 'button'; button.dataset.galleryRun = run.id;
    button.setAttribute('aria-label', '打开图片流程 · ' + (run.selection ? '已选择' : '未选择'));
    const cover = element('div', '', 'gallery-cover'), image = document.createElement('img'), marker = element('span', '读取预览…');
    const preview = run.selection || run.output || run.source;
    image.alt = run.selection ? '此流程已选作品' : run.source ? '此流程原图或结果' : '此流程生成结果'; image.hidden = true; cover.append(image, marker);
    const info = element('div', '', 'gallery-info');
    info.append(element('strong', run.selection ? '已选择 · 图片流程' : '未选择 · 图片流程'),
      element('p', new Date(run.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + run.modelRef));
    button.append(cover, info); button.addEventListener('click', () => openRun(run.id));
    if (preview) previews.set(button, { artifactId: preview.artifactId, image, marker, controller: new AbortController(), url: null, loading: false });
    else marker.textContent = '尚未生成';
    return button;
  }
  function audioCard(run) {
    const speech = run.recipe === 'speech/v0', article = element('article', '', 'gallery-card gallery-audio'); article.dataset.galleryRun = run.id;
    const cover = element('div', '', 'gallery-audio-cover');
    cover.append(element('span', speech ? '♪' : '≋', 'gallery-audio-icon'), element('span', speech ? 'VOICE' : 'TRANSCRIPT', 'eyebrow'));
    const info = element('div', '', 'gallery-info');
    info.append(element('strong', (run.output ? '已保存 · ' : '待完成 · ') + (speech ? '语音合成' : '音频转写')),
      element('p', new Date(run.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + run.modelRef));
    const actions = element('div', '', 'export-actions'), open = element('button', speech ? '查看作品' : '查看文字', 'quiet'); open.type = 'button';
    open.addEventListener('click', () => openRun(run.id)); actions.append(open);
    const artifact = speech ? run.output : run.source;
    if (artifact) {
      const play = element('button', speech ? '载入试听' : '载入原音频', 'quiet'); play.type = 'button'; play.dataset.galleryPlay = run.id; actions.append(play);
      const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.hidden = true;
      const note = element('p', '', 'field-note');
      play.addEventListener('click', async () => {
        clearAudio();
        const at = ticket, http = client, job = { controller: new AbortController(), player, button: play, url: null };
        activeAudio = job; play.disabled = true; note.textContent = '读取音频…';
        try {
          const blob = await http.get('/api/v0/artifacts/' + artifact.artifactId + '/audio', { binary: true, signal: job.controller.signal });
          if (!visible || at !== ticket || job !== activeAudio) return;
          job.url = URL.createObjectURL(blob); player.src = job.url; player.hidden = false; play.hidden = true; note.textContent = '点击播放器试听。';
        } catch (error) { if (job === activeAudio && !job.controller.signal.aborted) note.textContent = describe(error); }
        finally { if (job === activeAudio) play.disabled = false; }
      });
      info.append(actions, player, note);
    } else info.append(actions);
    article.append(cover, info); return article;
  }
  function counts(value) {
    for (const button of document.querySelectorAll('#gallery-filters button')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
      button.querySelector('span').textContent = String(value[button.dataset.filter]);
    }
  }
  async function load(more = false) {
    if (!client || !visible || more && busy) return;
    const at = ++ticket, http = client; busy = true;
    if (!more) { clear(); $('#gallery-grid').replaceChildren(); }
    else for (const item of previews.values()) { if (item.loading) { item.controller.abort(); item.loading = false; } }
    controller = new AbortController(); const signal = controller.signal;
    $('#gallery-grid').setAttribute('aria-busy', 'true'); $('#gallery-more').disabled = true;
    $('#gallery-feedback').textContent = '正在读取作品…'; $('#gallery-empty').hidden = true;
    try {
      const value = await http.get('/api/v0/runs?' + new URLSearchParams({ limit: '20', selection: filter,
        ...(audioEnabled ? { kind } : {}), ...(more && cursor ? { cursor } : {}) }), { signal });
      if (at !== ticket || client !== http || !visible) return;
      if (value.contractVersion !== 0 || !value.counts || !Array.isArray(value.runs)) throw new TypeError('不支持的作品列表');
      cursor = value.nextCursor; counts(value.counts);
      $('#gallery-grid').append(...value.runs.map(card)); observe();
      $('#gallery-more').hidden = !cursor; $('#gallery-empty').hidden = value.total !== 0;
      $('#gallery-feedback').textContent = value.total ? '共 ' + value.total + ' 个流程 · 点击作品接回创作' : '';
    } catch (error) { if (at === ticket && !signal.aborted) $('#gallery-feedback').textContent = describe(error); }
    finally { if (at === ticket) { busy = false; $('#gallery-grid').setAttribute('aria-busy', 'false'); $('#gallery-more').disabled = false; } }
  }
  for (const button of document.querySelectorAll('#gallery-filters button')) button.addEventListener('click', () => {
    if (button.dataset.filter === filter) return;
    filter = button.dataset.filter; cursor = null;
    for (const item of document.querySelectorAll('#gallery-filters button')) item.setAttribute('aria-pressed', String(item === button));
    void load();
  });
  for (const button of document.querySelectorAll('[data-gallery-kind]')) button.addEventListener('click', () => {
    if (!audioEnabled || button.dataset.galleryKind === kind) return;
    kind = button.dataset.galleryKind; filter = 'all'; cursor = null;
    for (const item of document.querySelectorAll('[data-gallery-kind]')) item.setAttribute('aria-pressed', String(item === button));
    $('#gallery-filters').hidden = kind !== 'image'; void load();
  });
  $('#gallery-refresh').addEventListener('click', () => { void load(); });
  $('#gallery-more').addEventListener('click', () => { void load(true); });
  return Object.freeze({
    connect(http, session) { client = http; audioEnabled = session?.audio === true; $('#gallery-types').hidden = !audioEnabled; },
    show(value) { if (visible === value) return; visible = value; if (value) void load(); else { ticket++; busy = false; clear(); $('#gallery-grid').replaceChildren(); } },
    disconnect() { visible = false; client = null; ticket++; busy = false; cursor = null; filter = 'all'; kind = 'image'; audioEnabled = false; clear();
      for (const item of document.querySelectorAll('[data-gallery-kind]')) item.setAttribute('aria-pressed', String(item.dataset.galleryKind === kind));
      $('#gallery-types').hidden = true; $('#gallery-filters').hidden = false; $('#gallery-grid').replaceChildren(); counts({ all: 0, selected: 0, unselected: 0 }); $('#gallery-feedback').textContent = ''; },
    refresh() { return load(); }
  });
}
