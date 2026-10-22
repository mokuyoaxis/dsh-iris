import { EventEmitter } from 'node:events';
import { defineHostAdapter } from '../lib/host-contract.js';
import { formatDoctorReport, hostDoctor } from '../lib/doctor.js';
import { serveApi } from './fixtures/dsh-runtime-fixture.mjs';
import {
  EXPECTED_IRIS_CLIENT_SEATS,
  EXPECTED_IRIS_ROUTES,
  EXPECTED_IRIS_SKILLS,
  EXPECTED_IRIS_TOOLS,
  HOST_CLIENT_PROTOCOL_VERSION,
  IRIS_PLUGIN_ID,
  beginHostRuntime,
  hostRuntimeEvidence,
  recordHostClient,
  recordHostRoutes,
  recordHostSkills,
  recordHostTool,
  resetHostRuntimeForTests
} from '../lib/host-runtime.js';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-host-doctor');
const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : ': ' + JSON.stringify(extra)));
};

let portCalls = 0;
const never = () => { portCalls++; throw new Error('Host Doctor 不得调用端口'); };
const fullPorts = {
  attachments: { saveImage: never, readImage: never },
  browser: { renderHtml: never },
  clientSlots: { inject: never, register: never },
  routes: { register: never },
  sessions: { readSession: never },
  skills: { register: never },
  textModel: { stream: never },
  tools: { register: never },
  visionModel: { analyze: never }
};
const fullHost = defineHostAdapter({ id: 'deepseek-harness', version: '0.2.0-rc.2', ports: fullPorts });

const version = '9.8.7-test';
const evidence = {
  server: { loaded: true, pluginId: IRIS_PLUGIN_ID, version },
  tools: EXPECTED_IRIS_TOOLS,
  skills: EXPECTED_IRIS_SKILLS,
  routes: EXPECTED_IRIS_ROUTES,
  client: {
    loaded: true,
    pluginId: IRIS_PLUGIN_ID,
    version,
    protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
    seats: EXPECTED_IRIS_CLIENT_SEATS
  }
};
const healthy = hostDoctor(fullHost, evidence, { packageVersion: version });
assert(healthy.mode === 'host' && healthy.exitCode === 0, '完整运行时证据应健康', healthy.summary);
assert(healthy.summary.errors === 0 && healthy.summary.warnings === 0, '完整证据不应产生误报', healthy.checks);
assert(portCalls === 0, 'Host Doctor 只能读取能力快照，不能调用端口', portCalls);
assert(!JSON.stringify(healthy).includes('Host Doctor 不得调用端口'), '报告不得序列化 live 方法或错误闭包');
assert(formatDoctorReport(healthy).includes('Iris Doctor ' + version + ' · host'), '文本报告应复用统一格式');
for (const [dshVersion, expected] of [
  ...['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.1', '0.1.7-rc.2',
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4']
    .flatMap(value => [[value, 'ok'], [value + '+fixture', 'ok']]),
  ...['0.1.0-rc.8', '0.1.1-rc.2', '0.1.2-rc.9', '0.1.2', '0.1.5-alpha.2', '0.1.5-rc.4',
    '0.1.7-rc.3', '0.2.0-rc.3', '0.2.0', '0.2.1-alpha.5', '0.2.1'].map(value => [value, 'error'])
]) {
  const report = hostDoctor(defineHostAdapter({ id: 'deepseek-harness', version: dshVersion, ports: fullPorts }),
    evidence, { packageVersion: version });
  assert(report.checks.some((item) => item.id === 'dsh-version' && item.status === expected),
    '只放行已验收的准确版本，不推定相邻预览版：' + dshVersion);
}
assert(portCalls === 0, '版本判定不得调用端口', portCalls);

const noClient = hostDoctor(fullHost, { ...evidence, client: null }, { packageVersion: version });
assert(noClient.exitCode === 1 && noClient.checks.some((item) => item.id === 'client' && item.status === 'warn'),
  '未打开浏览器只应给出可恢复警告', noClient.summary);

for (const [field, name, checkId, severity] of [
  ['tools', 'iris_generate_music', 'tools', 'error'],
  ['skills', 'iris-use', 'skills', 'warn']
]) {
  const report = hostDoctor(fullHost, { ...evidence, [field]: evidence[field].filter(item => item !== name) });
  const check = report.checks.find(item => item.id === checkId);
  assert(check.status === severity && check.summary.includes(name), '新增 Music/Skill 缺失必须明确诊断', check);
}

const unavailable = {};
for (const port of ['attachments', 'browser', 'clientSlots', 'routes', 'sessions', 'skills', 'textModel', 'tools', 'visionModel']) {
  unavailable[port] = { kind: port === 'browser' ? 'incompatible' : 'unavailable', reason: 'fixture ' + port };
}
const brokenHost = defineHostAdapter({ id: 'deepseek-harness', version: '0.1.3', unavailable });
const broken = hostDoctor(brokenHost, {
  server: { loaded: false, pluginId: 'wrong', version },
  tools: [],
  skills: [],
  routes: [],
  client: { loaded: true, pluginId: IRIS_PLUGIN_ID, version: 'old', protocolVersion: 99, seats: [] }
}, { packageVersion: version });
assert(broken.exitCode === 2, '必需端口、版本和插件身份异常应为硬错误', broken.summary);
assert(broken.checks.some((item) => item.id === 'dsh-version' && item.status === 'error'), '应识别 DSH 超出兼容范围');
assert(broken.checks.some((item) => item.id === 'browser' && /接口不兼容/.test(item.summary)), '应区分接口不兼容与缺失');
assert(broken.checks.some((item) => item.id === 'attachments' && /能力缺失/.test(item.summary)), '应说明可选能力缺失');
assert(portCalls === 0, '降级诊断也不得调用端口');

resetHostRuntimeForTests();
beginHostRuntime({ version });
for (const name of EXPECTED_IRIS_TOOLS) recordHostTool(name);
recordHostTool(EXPECTED_IRIS_TOOLS[0]);
recordHostSkills(EXPECTED_IRIS_SKILLS);
recordHostRoutes(EXPECTED_IRIS_ROUTES);
let rejectedSecret = false;
try {
  recordHostClient({
    pluginId: IRIS_PLUGIN_ID,
    version,
    protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
    seats: [],
    apiKey: 'must-not-enter-ledger'
  });
} catch (_) { rejectedSecret = true; }
assert(rejectedSecret, '客户端证据必须拒绝未声明字段');
recordHostClient({
  pluginId: IRIS_PLUGIN_ID,
  version,
  protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
  seats: EXPECTED_IRIS_CLIENT_SEATS
});
// 较早的小集合请求若迟到，不得覆盖已经收齐的四个 Slot。
recordHostClient({
  pluginId: IRIS_PLUGIN_ID,
  version,
  protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
  seats: [EXPECTED_IRIS_CLIENT_SEATS[0]]
});
let rejectedSeat = false;
try {
  recordHostClient({
    pluginId: IRIS_PLUGIN_ID,
    version,
    protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
    seats: ['unknown.slot']
  });
} catch (_) { rejectedSeat = true; }
assert(rejectedSeat, '客户端证据必须拒绝未知 Slot');
const ledger = hostRuntimeEvidence();
assert(ledger.tools.length === EXPECTED_IRIS_TOOLS.length && ledger.skills.length === 3 && ledger.routes.length === 4,
  '运行时账本应去重并覆盖当前工具/3 Skill/4路由注册事实', ledger);
assert(!JSON.stringify(ledger).includes('must-not-enter-ledger'), '账本不得保存未知字段或密钥');

function fakeRes(resolve) {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data) {
      this.writableEnded = true;
      this.body = data === undefined ? '' : String(data);
      if (resolve) resolve(this);
    }
  };
}
const apiReport = fakeRes();
serveApi({ method: 'GET', url: '/iris/api/doctor', headers: {} }, apiReport, fullHost);
assert(apiReport.status === 200 && JSON.parse(apiReport.body).exitCode === 0, 'Host Doctor GET 端点应返回运行时健康报告');

const posted = await new Promise((resolve) => {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/iris/api/host-client';
  req.headers = {};
  const res = fakeRes(resolve);
  serveApi(req, res, fullHost);
  req.emit('data', Buffer.from(JSON.stringify({
    pluginId: IRIS_PLUGIN_ID,
    version,
    protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
    seats: EXPECTED_IRIS_CLIENT_SEATS
  })));
  req.emit('end');
});
assert(posted.status === 200 && JSON.parse(posted.body).acceptedSeats === 4,
  '同源客户端握手端点应接受受限标量报告', posted.body);

const noHost = fakeRes();
serveApi({ method: 'GET', url: '/iris/api/doctor', headers: {} }, noHost);
assert(noHost.status === 503, '没有 Host Adapter 时不得伪造 Host Doctor 结果');

console.log(`ALL OK —— Host Doctor 健康/降级/零调用、Music及iris-use缺失诊断、${EXPECTED_IRIS_TOOLS.length}+3+4账本通过`);
