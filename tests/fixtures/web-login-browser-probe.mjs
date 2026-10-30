import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';

export async function verifyWebLoginBrowser({ out, dataRoot, session, tokenFile, cdp, evaluate, click, wait, chooseToken,
  report, save, dimensions, measure, capture, pausedResponses, tree, restart }) {
  const result = report.webLogin = { checks: [] }, key = 'iris.workbench.session.v0', before = tree(dataRoot);
  const connected = () => evaluate("document.querySelector('#connection')?.hidden===true&&document.body.classList.contains('connected')");
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const mint = async () => {
    const response = await fetch(session.origin + '/api/v0/workbench/login-link', { method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); return response.json();
  };
  let loginUrl = session.loginUrl;
  const portal = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><a id="enter" href="' + loginUrl + '">Open local workbench</a>');
  });
  await new Promise((resolve, reject) => { portal.once('error', reject); portal.listen(0, '127.0.0.1', resolve); });
  const portalOrigin = 'http://localhost:' + portal.address().port;
  try {
    await check('link is the primary instruction and manual credentials are folded away', "document.querySelector('#login-help').textContent.includes('登录链接')&&!document.querySelector('#paste-panel').open&&document.querySelector('#paste-panel summary').textContent.includes('备用登录')");
    await dimensions(390); await measure('login-390'); await capture('login-390');
    await cdp('Page.navigate', { url: portalOrigin });
    await wait(() => evaluate("!!document.querySelector('#enter')"), 'external link fixture');
    await click('#enter'); await wait(connected, 'one-click navigation from another origin');
    await check('clicking a cross-site link logs in, scrubs the fragment and stores a separate browser credential', `!location.hash.includes('login=')&&!location.search&&!document.querySelector('#token').value&&/^[A-Za-z0-9_-]{43}$/.test(sessionStorage.getItem(${JSON.stringify(key)}))&&sessionStorage.getItem(${JSON.stringify(key)})!==${JSON.stringify(session.accessToken)}`);
    await check('browser credentials avoid persistent localStorage', "Object.keys(localStorage).every(k=>k==='iris.panel.appearance.v0')");
    const postCount = () => report.requests.filter(item => item.method === 'POST').length;
    assert.equal(postCount(), 1);
    result.checks.push('one click exchanges exactly once and submits no media');
    await cdp('Page.reload'); await wait(connected, 'refresh retained login');
    assert.equal(postCount(), 1); result.checks.push('refresh validates the saved browser credential using GET only');
    await capture('one-click-390');
    await click('#disconnect');
    await check('logout clears the tab credential and private workspace', `sessionStorage.getItem(${JSON.stringify(key)})===null&&!document.querySelector('#connection').hidden&&document.querySelector('#workspace').hidden`);
    await cdp('Page.navigate', { url: loginUrl });
    await wait(() => evaluate("document.querySelector('#feedback')?.textContent.includes('已失效或已使用')===true"), 'reused login link');
    await check('reused links remain logged out and explain how to regain access', "!location.hash&&!document.querySelector('#connection').hidden&&document.querySelector('#feedback').textContent.includes('获取新链接')&&!document.querySelector('#connect').disabled");
    await click('#paste-panel>summary'); await chooseToken(tokenFile); await wait(connected, 'manual fallback after link failure');
    await check('manual Token remains a working fallback', `sessionStorage.getItem(${JSON.stringify(key)})===${JSON.stringify(session.accessToken)}`);
    const fresh = await mint(); loginUrl = fresh.loginUrl;
    await cdp('Page.navigate', { url: loginUrl }); await wait(connected, 'new link in an already mounted page');
    await wait(() => evaluate(`sessionStorage.getItem(${JSON.stringify(key)})!==${JSON.stringify(session.accessToken)}`), 'fresh browser credential');
    result.checks.push('a new link also works through hash navigation in an existing page');
    session = await restart();
    await cdp('Page.reload');
    await wait(() => evaluate("document.querySelector('#connection')?.hidden===false&&document.querySelector('#feedback').textContent.includes('失效')"), 'browser credential rejected after restart');
    await check('restart rejects and clears the old browser login without media replay', `sessionStorage.getItem(${JSON.stringify(key)})===null&&document.querySelector('#feedback').textContent.includes('登录链接')`);
    const latestFile = path.join(out, 'latest-login-owner'); writeLocalApiTokenFile(latestFile, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: session.loginUrl }); await wait(connected, 'new service login link');
    result.checks.push('fresh startup link restores access after restart');
    await click('#disconnect');
    const delayed = await mint();
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/workbench/login', requestStage: 'Response' }] });
    await cdp('Page.navigate', { url: delayed.loginUrl });
    await wait(() => pausedResponses.length > 0, 'held login response');
    await click('#paste-panel>summary'); await chooseToken(latestFile); await wait(connected, 'manual login supersedes held exchange');
    // Manual login aborts the held fetch, invalidating its interception ID in Chromium.
    pausedResponses.shift(); await cdp('Fetch.disable');
    await check('a canceled exchange cannot replace an explicitly chosen manual session', `sessionStorage.getItem(${JSON.stringify(key)})===${JSON.stringify(session.accessToken)}&&document.querySelector('#connection').hidden`);
    await click('#disconnect');
    const blocked = await mint();
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('blocked','SecurityError')}})" });
    loginUrl = blocked.loginUrl;
    await cdp('Page.navigate', { url: portalOrigin });
    await wait(() => evaluate("!!document.querySelector('#enter')"), 'storage-blocked external page');
    await click('#enter'); await wait(connected, 'link login without browser storage');
    await check('blocked storage still permits this login and explains refresh limits', "!document.querySelector('#session-notice').hidden&&document.querySelector('#session-notice').textContent.includes('刷新后需要重新登录')");
    const oldPosts = postCount(); await cdp('Page.reload');
    await wait(() => evaluate("document.documentElement.dataset.startup==='ready'&&document.querySelector('#connection')?.hidden===false"), 'blocked storage refresh');
    assert.equal(postCount(), oldPosts); result.checks.push('storage-blocked refresh does not retry the consumed ticket');
    await cdp('Page.navigate', { url: session.origin + '/#login=malformed' });
    await wait(() => evaluate("document.querySelector('#feedback')?.textContent.includes('登录链接无效')===true"), 'bad fragment format');
    await check('malformed link fragments are removed without a request', "!location.hash&&!document.querySelector('#connect').disabled");
    assert.equal(postCount(), oldPosts);
    assert.deepEqual(tree(dataRoot), before); result.checks.push('all login paths leave Core byte-for-byte unchanged');
    assert(report.requests.filter(item => item.method === 'POST').every(item => new URL(item.url).pathname === '/api/v0/workbench/login'));
    result.checks.push('browser POSTs are limited to login exchange, with no media or management writes');
    assert(report.requests.every(item => ['blob:', session.origin, portalOrigin].some(origin => item.url.startsWith(origin))));
    await capture('login-fallback-390');
  } finally {
    const closed = new Promise(resolve => portal.close(resolve)); portal.closeAllConnections(); await closed;
  }
}
