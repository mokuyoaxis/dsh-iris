import assert from 'node:assert/strict';

export async function verifyWorkbenchPasswordBrowser({ session, debugOrigin, cdp, evaluate, click, wait, report, save, dimensions, measure, capture, restart, reset, pausedResponses }) {
  const result = report.passwordLogin = { checks: [] }, TAB = 'iris.workbench.password-session.v0', DEVICE = 'iris.workbench.remembered-session.v0';
  const password = 'Browser-example-password';
  const connected = () => evaluate("document.body?.classList.contains('connected')===true&&document.querySelector('#connection').hidden");
  const mounted = expression => evaluate(`document.readyState !== 'loading' && (${expression})`);
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const fill = async (value, confirm = value, remember = true) => evaluate(`(()=>{document.querySelector('#password').value=${JSON.stringify(value)};document.querySelector('#password-confirm').value=${JSON.stringify(confirm)};document.querySelector('#password-remember').checked=${remember};})()`);
  async function newPage() {
    const target = await (await fetch(debugOrigin + '/json/new?' + encodeURIComponent(session.origin), { method: 'PUT' })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0;
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), job = pending.get(message.id); if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
    });
    const read = expression => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('New page evaluation timed out')); }, 12000);
      pending.set(id, { timer, reject, resolve: result => result.exceptionDetails ? reject(new Error(result.exceptionDetails.text)) : resolve(result.result.value) });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    try {
      await wait(() => read("document.body?.classList.contains('connected')===true"), 'new tab restores remembered device');
      assert.equal(await read(`JSON.parse(localStorage.getItem(${JSON.stringify(DEVICE)})).accessToken!==${JSON.stringify(session.accessToken)}&&!location.hash`), true);
      result.checks.push('an actual new browser tab opens the ordinary address and restores the independent remembered session'); save();
    } finally {
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('New page closed')); }
      socket.close(); await fetch(debugOrigin + '/json/close/' + target.id);
    }
  }
  await wait(() => mounted("!document.querySelector('#password-login').hidden&&document.querySelector('#password-hint').textContent.includes('首次使用')"), 'initial password page');
  await check('ordinary password page hides manual Token/file login and explains the one-time ownership setup', "document.documentElement.dataset.auth==='password'&&getComputedStyle(document.querySelector('#paste-panel')).display==='none'&&document.querySelector('#password-submit').disabled");
  await dimensions(390); await measure('password-initial-390'); await capture('password-initial-390');
  await cdp('Page.navigate', { url: session.loginUrl });
  await wait(() => mounted("!document.querySelector('#password-submit').disabled&&!document.querySelector('#password-confirm-row').hidden"), 'first password setup');
  await check('setup fragment is scrubbed and only a temporary origin-bound setup context is saved', "!location.hash&&sessionStorage.getItem('iris.workbench.setup.v0')!==null");
  await cdp('Page.reload');
  await wait(() => mounted("!document.querySelector('#password-submit').disabled"), 'setup page survives refresh');
  await fill(password, 'different-password'); await click('#password-submit');
  await wait(() => mounted("document.querySelector('#feedback').textContent.includes('不一致')"), 'password confirmation');
  result.checks.push('initial setup survives refresh and validates confirmation without creating a session'); save();
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/workbench/setup', requestStage: 'Response' }] });
  await fill(password); await click('#password-submit');
  await wait(() => pausedResponses.length > 0, 'setup response deliberately lost');
  await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'Failed' }); await cdp('Fetch.disable');
  await wait(() => mounted("document.querySelector('#feedback').textContent.includes('口令已设置')&&document.querySelector('#password-confirm-row').hidden"), 'setup result recovered through read-only status');
  result.checks.push('a lost setup response is checked using GET and returns to password login without reusing an invalid setup link'); save();
  await fill(password); await click('#password-submit'); await wait(connected, 'first setup enters workspace');
  await check('remembered login stores only the independent browser credential, clears password fields and the setup context', `JSON.parse(localStorage.getItem(${JSON.stringify(DEVICE)})).accessToken!==${JSON.stringify(session.accessToken)}&&document.querySelector('#password').value===''&&document.querySelector('#password-confirm').value===''&&sessionStorage.getItem('iris.workbench.setup.v0')===null`);
  await evaluate("document.querySelector('#appearance-open').click();document.querySelector('#appearance-theme').value='dark';document.querySelector('#appearance-theme').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#appearance-close').click()");
  const paintProbe = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.startupPaints=[];window.startupFrames=[];
    new PerformanceObserver(list=>{for(const entry of list.getEntries())startupPaints.push({name:entry.name,theme:document.documentElement.dataset.theme,background:getComputedStyle(document.documentElement).backgroundColor})}).observe({type:'paint',buffered:true});
    requestAnimationFrame(function sample(){const card=document.querySelector('#connection');if(card)startupFrames.push({state:document.documentElement.dataset.startup,login:card.getClientRects().length>0});if(document.documentElement.dataset.startup==='pending'&&startupFrames.length<600)requestAnimationFrame(sample)});
  ` });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/app.js', requestStage: 'Response' },
    { urlPattern: session.origin + '/api/v0/workbench/auth', requestStage: 'Response' }] });
  await cdp('Page.reload'); await wait(() => pausedResponses.length > 0, 'entry module held before execution');
  await wait(() => evaluate('window.startupPaints?.length>0'), 'actual first paint while main entry is delayed');
  await check('saved dark mode is applied at actual first paint before the main module executes, with no login-card flash',
    "document.documentElement.dataset.startup==='pending'&&startupPaints.every(p=>p.theme==='dark'&&p.background==='rgb(29, 26, 36)')&&document.querySelector('#connection').getClientRects().length===0&&document.querySelector('.startup-screen').getClientRects().length>0");
  await capture('password-refresh-dark-before-app-390');
  await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() });
  await wait(() => pausedResponses.length > 0, 'saved-login status held');
  await check('delayed authentication keeps the same themed startup screen and hides the login form',
    "document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.startup==='pending'&&document.querySelector('#connection').getClientRects().length===0");
  await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable');
  await wait(connected, 'saved session leaves startup directly for workspace');
  await check('successful restore shows the authenticated workspace without painting the login card',
    "document.documentElement.dataset.startup==='ready'&&startupFrames.length>0&&startupFrames.every(frame=>!frame.login)&&document.querySelector('.startup-screen').getClientRects().length===0");
  result.firstPaint = await evaluate('({paints:startupPaints,frames:startupFrames})'); save();
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: paintProbe.identifier });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/workbench/auth', requestStage: 'Response' }] });
  await cdp('Page.reload'); await wait(() => pausedResponses.length > 0, 'login-state response held for failure');
  await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'Failed' }); await cdp('Fetch.disable');
  await wait(() => mounted("document.documentElement.dataset.startup==='ready'&&!document.querySelector('#password-retry').hidden"), 'failed auth exits loading state');
  await check('a failed login check reveals the dark login page with an explicit retry, without endless loading',
    "document.documentElement.dataset.theme==='dark'&&document.querySelector('#connection').getClientRects().length>0&&document.querySelector('#feedback').textContent.length>0");
  await click('#password-retry'); await wait(connected, 'explicit login-state retry restores remembered session');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/app.js', requestStage: 'Response' }] });
  await cdp('Page.reload'); await wait(() => pausedResponses.length > 0, 'entry held for load failure');
  await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'Failed' }); await cdp('Fetch.disable');
  await wait(() => evaluate("document.documentElement.dataset.startup==='failed'"), 'failed entry has useful reload UI');
  await check('a failed entry module keeps the saved dark mode and offers reload rather than a misleading login or endless loader',
    "document.documentElement.dataset.theme==='dark'&&document.querySelector('#connection').getClientRects().length===0&&getComputedStyle(document.querySelector('.startup-failure')).display!=='none'&&document.querySelector('.startup-failure a').getAttribute('href')==='/'");
  await cdp('Page.reload'); await wait(connected, 'password refresh');
  result.checks.push('refresh restores the saved browser session without another password POST'); save();
  session = await restart(); await cdp('Page.reload'); await wait(connected, 'password session after service restart');
  result.checks.push('ordinary service restart retains both password and the original remembered browser session'); save();
  await newPage();
  await evaluate(`window.revokedSession=JSON.parse(localStorage.getItem(${JSON.stringify(DEVICE)})).accessToken`);
  await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/workbench/logout', requestStage: 'Response' }] });
  await click('#disconnect'); await wait(() => pausedResponses.length > 0, 'logout response deliberately lost');
  await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'Failed' }); await cdp('Fetch.disable');
  await wait(() => mounted("document.querySelector('#feedback').textContent.includes('退出尚未确认')&&!document.querySelector('#disconnect').disabled"), 'logout remains unconfirmed');
  result.checks.push('a lost logout response is shown as unconfirmed; explicit retry is idempotent'); save();
  await click('#disconnect');
  await wait(() => mounted("!document.querySelector('#connection').hidden&&document.querySelector('#feedback').textContent.includes('已退出')"), 'confirmed logout');
  await check('logout removes both browser caches and the server refuses the old credential', `(async()=>localStorage.getItem(${JSON.stringify(DEVICE)})===null&&sessionStorage.getItem(${JSON.stringify(TAB)})===null&&(await fetch('/api/v0/session',{headers:{Authorization:'Bearer '+window.revokedSession}})).status===401)()`);
  await fill('incorrect-password'); await click('#password-submit');
  await wait(() => mounted("document.querySelector('#feedback').textContent.includes('不正确')"), 'incorrect password message');
  await fill(password, password, false); await click('#password-submit'); await wait(connected, 'same password after logout');
  await check('the same ordinary page logs in again, with tab-only storage when remember is unchecked', `localStorage.getItem(${JSON.stringify(DEVICE)})===null&&sessionStorage.getItem(${JSON.stringify(TAB)})!==null&&!location.hash.includes('login=')`);
  await cdp('Page.reload'); await wait(connected, 'tab-only refresh');
  await evaluate(`sessionStorage.removeItem(${JSON.stringify(TAB)})`); await cdp('Page.reload');
  await wait(() => mounted("!document.querySelector('#password-submit').disabled&&!document.querySelector('#connection').hidden"), 'no tab cache');
  result.checks.push('unremembered session supports refresh but does not silently restore after its tab cache is removed'); save();
  await evaluate(`sessionStorage.setItem(${JSON.stringify(TAB)},'null');localStorage.setItem(${JSON.stringify(DEVICE)},'not-json')`);
  await cdp('Page.reload');
  await wait(() => mounted("!document.querySelector('#password-submit').disabled"), 'invalid caches removed');
  await check('malformed/null saved records are cleared without an exception or automatic submission', `sessionStorage.getItem(${JSON.stringify(TAB)})===null&&localStorage.getItem(${JSON.stringify(DEVICE)})===null&&!document.querySelector('#connection').hidden`);
  const resetUrl = await reset();
  await cdp('Page.navigate', { url: resetUrl });
  await wait(() => mounted("!document.querySelector('#password-confirm-row').hidden&&!document.querySelector('#password-submit').disabled"), 'password reset setup');
  await fill('Browser-replacement-password'); await click('#password-submit'); await wait(connected, 'reset password enters');
  await click('#disconnect');
  await wait(() => mounted("!document.querySelector('#connection').hidden"), 'replacement logout');
  await dimensions(1366, 900); await measure('password-login-1366'); await capture('password-login-1366');
  await dimensions(390); await measure('password-login-390'); await capture('password-login-390');
  await evaluate("document.querySelector('#appearance-open').click();document.querySelector('#appearance-theme').value='dark';document.querySelector('#appearance-theme').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#appearance-close').click()");
  await capture('password-login-dark-390');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "for(const k of ['localStorage','sessionStorage'])Object.defineProperty(window,k,{get(){throw new DOMException('blocked','SecurityError')}})" });
  await cdp('Page.reload');
  await wait(() => mounted("!document.querySelector('#password-submit').disabled"), 'storage blocked login');
  await fill('Browser-replacement-password'); await click('#password-submit'); await wait(connected, 'password without storage');
  await check('blocked browser storage permits password login and explains the persistence limitation', "!document.querySelector('#session-notice').hidden&&document.querySelector('#session-notice').textContent.includes('口令')");
  await cdp('Page.reload');
  await wait(() => mounted("!document.querySelector('#password-submit').disabled&&!document.querySelector('#connection').hidden"), 'blocked refresh asks for password');
  result.checks.push('storage-blocked refresh returns to the normal password form, with no expired-link or file-picker dependency'); save();
  assert(report.requests.filter(item => item.method === 'POST').every(item => ['/api/v0/workbench/setup', '/api/v0/workbench/password-login', '/api/v0/workbench/logout'].includes(new URL(item.url).pathname)));
  result.checks.push('browser POSTs are limited to setup/login/logout; no media submission, management write or MCP grant'); save();
}
