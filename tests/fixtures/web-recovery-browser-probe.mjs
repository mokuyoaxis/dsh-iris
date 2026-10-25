import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './image-flow-fixture.mjs';

/** Deliberate writes belong to this controlled QA phase, never to the production page. */
export async function verifyWebRecoveryBrowser({ out, dataRoot, chosenRunId, restart, cdp, evaluate, click, wait,
  chooseToken, readyRun, tree, report, save, dimensions, measure, capture }) {
  const recovery = report.recovery = { status: 'running', checks: [], actualPaidCalls: 0 };
  const key = 'iris.workbench.recovery.v0';
  const checks = async (name, expression) => { assert.equal(await evaluate(expression), true, name); recovery.checks.push(name); save(); };
  const ports = imageFlowFixture(dataRoot);
  let session = await restart(dataRoot, ports), tokenSequence = 0, other;
  async function login(id) {
    const tokenFile = path.join(out, 'recovery-token-' + ++tokenSequence);
    writeLocalApiTokenFile(tokenFile, session.accessToken, dataRoot);
    await cdp('Page.reload');
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'recovery public login');
    const count = report.requests.length;
    await chooseToken(tokenFile); await readyRun(id);
    await wait(() => evaluate("!document.querySelector('#recovery-check').disabled"), 'recovery reads finished');
    assert(report.requests.slice(count).every(item => item.method === 'GET'), 'the real page reconnects using GET only');
    recovery.checks.push('reconnect performs GET only'); save();
  }
  async function harness() {
    await evaluate(`(async()=>{
      const {createReadClient}=await import('/transport.js');const {createMediaClient}=await import('/media-client.js');
      window.qaHttp=createReadClient(${JSON.stringify(session.accessToken)});window.qaSession=await qaHttp.get('/api/v0/session');
      window.qaMedia=createMediaClient({client:qaHttp,session:qaSession,origin:location.origin});
      const native=fetch;window.qaLose=null;window.fetch=async(url,options)=>{const response=await native(url,options);
        if(qaLose===url&&options?.method==='POST'&&response.ok){qaLose=null;await response.arrayBuffer();throw new TypeError('QA lost committed response')}return response};
      window.qaImage=new Blob([Uint8Array.from(atob(${JSON.stringify(FLOW_SOURCE.toString('base64'))}),c=>c.charCodeAt(0))],{type:'image/png'});
    })()`);
  }
  try {
    await dimensions(1366, 900);
    await login(chosenRunId); await harness();
    const rootId = await evaluate('qaSession.rootId');
    await evaluate(`(async()=>{window.qaSource=(await qaMedia.uploadImage(qaImage)).artifact.artifactId;
      qaLose='/api/v0/runs';try{await qaMedia.createRun({sourceArtifactId:qaSource,modelRef:${JSON.stringify(FLOW_MODEL)},prompt:'PRIVATE_BROWSER_RECOVERY_PROMPT'});throw Error('Expected response loss')}
      catch(error){if(!error.message.includes('QA lost'))throw error}})()`);
    await checks('pending tab record contains only finite identities, with no token or prompt', `(()=>{const raw=sessionStorage.getItem(${JSON.stringify(key)}),table=JSON.parse(raw);
      return table.actions.length===1&&table.actions[0].kind==='flow-create'&&Object.keys(table.actions[0]).sort().join(',')==='artifactId,id,key,kind'
      &&!raw.includes('PRIVATE_BROWSER_RECOVERY_PROMPT')&&!raw.includes(${JSON.stringify(session.accessToken)})&&localStorage.length===0})()`);
    const before = tree(dataRoot), events = readFlowEvents(dataRoot);
    await login(chosenRunId);
    await checks('refresh finds the committed create without executing, and feedback starts folded', `!document.querySelector('#recovery-panel').hidden&&!document.querySelector('#recovery-panel').open
      &&document.querySelector('#recovery-list').textContent.includes('流程创建 · 已读取原结果')&&sessionStorage.getItem(${JSON.stringify(key)})===null`);
    await click('#recovery-panel>summary'); await click('#recovery-list button');
    await wait(() => evaluate(`location.hash!==${JSON.stringify('#' + chosenRunId)}`), 'recovered Run navigation');
    const newRunId = await evaluate('location.hash.slice(1)'); await readyRun(newRunId);
    await checks('recovered creation opens the exact not_started Run', "document.querySelector('#status-title').textContent==='已保存，尚未开始'&&document.querySelector('#download').disabled");
    assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), events); assert.equal(ports.calls.submit.length, 0);
    recovery.checks.push('creation recovery changes no Core bytes and calls no Provider');
    await capture('recovery-created');

    // A selection response is not replayed: show the current authoritative choice instead.
    await harness();
    const selected = await evaluate(`(async()=>{const view=await qaHttp.getRun(${JSON.stringify(chosenRunId)});qaLose='/api/v0/runs/'+view.id+'/selection';
      try{await qaMedia.selectRun(view.id,view.source.artifactId,view.revision);throw Error('Expected response loss')}
      catch(error){if(!error.message.includes('QA lost'))throw error}return view.source.artifactId})()`);
    const selectedBytes = tree(dataRoot); await login(newRunId);
    await checks('selection loss is recovered as current state, with no attribution to the lost request', "document.querySelector('#recovery-list').textContent.includes('作品选择 · 已读取当前选择')");
    await click('#recovery-panel>summary'); await click('#recovery-list button'); await readyRun(chosenRunId);
    await checks('original-image choice remains authoritative after refresh', "document.querySelector('#status-title').textContent==='已选择原图'&&!document.querySelector('#download').disabled");
    assert.deepEqual(tree(dataRoot), selectedBytes); await click('#download');
    const downloaded = path.join(out, 'downloads', 'iris-' + selected + '.png');
    await wait(() => fs.existsSync(downloaded), 'recovery original download'); assert.deepEqual(fs.readFileSync(downloaded), FLOW_SOURCE);
    recovery.checks.push('download matches the current selected original bytes');
    for (const width of [390, 320]) { await dimensions(width); await measure('recovery-' + width); await capture('recovery-' + width); }
    await click('#recovery-panel>summary'); await dimensions(1366, 900);

    // Host restart keeps the pending identity but requires a fresh owner Token.
    await harness();
    await evaluate("(async()=>{qaLose='/api/v0/images';try{await qaMedia.uploadImage(qaImage);throw Error('Expected response loss')}catch(error){if(!error.message.includes('QA lost'))throw error}})()");
    const pending = await evaluate(`sessionStorage.getItem(${JSON.stringify(key)})`);
    session = await restart(dataRoot, imageFlowFixture(dataRoot)); await login(chosenRunId);
    await checks('host restart recovers the original upload using stable root identity', `!document.querySelector('#recovery-panel').hidden
      &&document.querySelector('#recovery-list').textContent.includes('素材保存 · 已读取原结果')&&sessionStorage.getItem(${JSON.stringify(key)})===null`);
    assert.equal(JSON.parse(pending).rootId, rootId); assert.equal(readFlowEvents(dataRoot).length, events.length);
    await harness(); assert.equal(await evaluate('qaSession.rootId'), rootId);
    // Retain a genuinely unknown request from a failure before send.
    await evaluate(`(async()=>{const native=fetch;window.fetch=(url,options)=>options?.method==='POST'?Promise.reject(new TypeError('QA before send')):native(url,options);
      try{await qaMedia.uploadImage(qaImage);throw Error('Expected before-send failure')}catch(error){if(!error.message.includes('QA before send'))throw error}})()`);
    const oldTable = await evaluate(`sessionStorage.getItem(${JSON.stringify(key)})`); assert.equal(JSON.parse(oldTable).actions.length, 1);
    const otherRoot = path.join(out, 'other-core'), otherPorts = imageFlowFixture(otherRoot);
    other = createApplicationRuntime({ dataRoot: otherRoot, ...otherPorts });
    await other.execute('flow.init', {}); await other.execute('execution.init', {});
    session = await restart(otherRoot, otherPorts); const otherBefore = tree(otherRoot);
    const tokenFile = path.join(out, 'changed-root-token'); writeLocalApiTokenFile(tokenFile, session.accessToken, otherRoot);
    await cdp('Page.reload'); await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'changed root login');
    const readStart = report.requests.length; await chooseToken(tokenFile);
    await wait(() => evaluate("!document.querySelector('#workspace').hidden&&document.querySelector('#recovery-note').textContent.includes('工作区已改变')"), 'changed root notice');
    await checks('same origin with a different root clears only obsolete tab identities', `sessionStorage.getItem(${JSON.stringify(key)})===null&&localStorage.length===0
      &&document.querySelector('#recovery-note').textContent.includes('原服务记录仍保留')`);
    assert(report.requests.slice(readStart).every(item => item.method === 'GET'));
    assert.deepEqual(tree(otherRoot), otherBefore); assert.equal(otherPorts.calls.submit.length, 0);
    await click('#recovery-panel>summary'); await dimensions(320); await measure('recovery-root-change'); await capture('recovery-root-change');
    recovery.checks.push('root change causes no writes or Provider calls in the destination');
    recovery.status = 'passed'; recovery.controlledProviderSubmits = ports.calls.submit.length; save(); return recovery;
  } finally { if (other) await other.dispose(); }
}
