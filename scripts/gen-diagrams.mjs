'use strict';

// 从同一份图规格生成三种产物：
//   docs/assets/diagrams/<name>.svg    GitHub/README 直接渲染
//   docs/assets/diagrams/<name>.png    README 实际引用（2x 栅格，sharp 渲染）
//   docs/assets/diagrams/<name>.drawio 可编辑源文件
// 用法：node scripts/gen-diagrams.mjs

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('docs/assets/diagrams');
fs.mkdirSync(OUT, { recursive: true });

// ---------- 调色 ----------
const C = {
  ink: '#1f2328',
  sub: '#5b6472',
  edge: '#6b7686',
  stroke: '#b9c2ce',
  processFill: '#eef3ff',
  processStroke: '#4d6bfe',
  okFill: '#eaf7ef',
  okStroke: '#2e9e5b',
  warnFill: '#fff6e5',
  warnStroke: '#c98a1b',
  badFill: '#fceded',
  badStroke: '#c94f4f',
  muteFill: '#f5f6f8',
  muteStroke: '#b9c2ce',
  noteFill: '#ffffff',
  noteStroke: '#b9c2ce',
};

const STYLES = {
  process: { fill: C.processFill, stroke: C.processStroke },
  ok: { fill: C.okFill, stroke: C.okStroke },
  warn: { fill: C.warnFill, stroke: C.warnStroke },
  bad: { fill: C.badFill, stroke: C.badStroke },
  mute: { fill: C.muteFill, stroke: C.muteStroke },
  note: { fill: C.noteFill, stroke: C.noteStroke, dashed: true },
};

// ---------- 几何辅助 ----------
function anchor(n, side, frac = 0.5) {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  switch (side) {
    case 'n': return { x: n.x + n.w * frac, y: n.y };
    case 's': return { x: n.x + n.w * frac, y: n.y + n.h };
    case 'w': return { x: n.x, y: n.y + n.h * frac };
    case 'e': return { x: n.x + n.w, y: n.y + n.h * frac };
    default: return { x: cx, y: cy };
  }
}

// 依据出口/入口方位生成正交折线拐点
function route(a, exitSide, b, entrySide, mid) {
  const p0 = anchor(a, exitSide, (a._f ?? 0.5));
  const p1 = anchor(b, entrySide, (b._f ?? 0.5));
  const pts = [p0];
  const key = exitSide + '>' + entrySide;
  if (key === 'e>w' || key === 'w>e') {
    if (Math.abs(p0.y - p1.y) > 1) {
      const mx = mid?.x ?? (p0.x + p1.x) / 2;
      pts.push({ x: mx, y: p0.y }, { x: mx, y: p1.y });
    }
  } else if (key === 's>n' || key === 'n>s') {
    if (Math.abs(p0.x - p1.x) > 1) {
      const my = mid?.y ?? (p0.y + p1.y) / 2;
      pts.push({ x: p0.x, y: my }, { x: p1.x, y: my });
    }
  } else if (exitSide === 's') {
    pts.push({ x: p0.x, y: mid?.y ?? p1.y }, { x: p1.x, y: mid?.y ?? p1.y });
  } else if (exitSide === 'n') {
    pts.push({ x: p0.x, y: mid?.y ?? p1.y }, { x: p1.x, y: mid?.y ?? p1.y });
  } else if (exitSide === 'e') {
    pts.push({ x: mid?.x ?? p1.x, y: p0.y }, { x: mid?.x ?? p1.x, y: p1.y });
  } else if (exitSide === 'w') {
    pts.push({ x: mid?.x ?? p1.x, y: p0.y }, { x: mid?.x ?? p1.x, y: p1.y });
  }
  pts.push(p1);
  return pts;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// CJK ≈ 1em，ASCII ≈ 0.56em
function textWidth(s, fs) {
  let w = 0;
  for (const ch of s) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? fs : fs * 0.56;
  return w;
}

function renderSvg(spec) {
  const { width: W, height: H, title, subtitle, nodes, edges, notes } = spec;
  const parts = [];
  const FONT = "'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Noto Sans SC','Microsoft YaHei',sans-serif";
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`);
  parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.edge}"/></marker></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="48" y="52" font-family="${FONT}" font-size="21" font-weight="700" fill="${C.ink}">${esc(title)}</text>`);
  parts.push(`<text x="48" y="78" font-family="${FONT}" font-size="13" fill="${C.sub}">${esc(subtitle)}</text>`);

  // 容器/背景类节点先画
  for (const n of nodes.filter((n) => n.kind === 'container')) {
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="none" stroke="${C.stroke}" stroke-width="1.4"/>`);
    parts.push(`<text x="${n.x + 14}" y="${n.y + 24}" font-family="${FONT}" font-size="12.5" fill="${C.sub}">${esc(n.label)}</text>`);
  }

  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.from);
    const b = nodes.find((n) => n.id === e.to);
    if (e.via) {
      // 显式路径（含起终点锚点）
      const p0 = anchor(a, e.fromSide ?? 'e', e.fromFrac ?? 0.5);
      const p1 = anchor(b, e.toSide ?? 'w', e.toFrac ?? 0.5);
      e._pts = [p0, ...e.via, p1];
    } else {
      a._f = e.fromFrac ?? 0.5;
      b._f = e.toFrac ?? 0.5;
      e._pts = route(a, e.fromSide ?? 'e', b, e.toSide ?? 'w', e.mid);
    }
    const d = e._pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.6" ${e.dashed ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#arr)"/>`);
    if (e.label) {
      const midIdx = Math.max(1, Math.floor(e._pts.length / 2) - (e._pts.length % 2 === 0 ? 1 : 0));
      const segA = e._pts[midIdx - 1] ?? e._pts[0];
      const segB = e._pts[midIdx] ?? e._pts[e._pts.length - 1];
      let lx = (segA.x + segB.x) / 2;
      let ly = (segA.y + segB.y) / 2;
      if (e.lx !== undefined) lx = e.lx;
      if (e.ly !== undefined) ly = e.ly;
      const w = textWidth(e.label, 12) + 10;
      parts.push(`<rect x="${lx - w / 2}" y="${ly - 9.5}" width="${w}" height="19" rx="4" fill="#ffffff"/>`);
      parts.push(`<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${C.sub}">${esc(e.label)}</text>`);
    }
  }

  for (const n of nodes.filter((n) => n.kind !== 'container')) {
    const st = STYLES[n.kind] ?? STYLES.process;
    const dash = st.dashed ? 'stroke-dasharray="5 4"' : '';
    if (n.kind === 'note') {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.3" ${dash}/>`);
    } else if (n.kind === 'start') {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.h / 2}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"/>`);
    } else if (n.kind === 'decision') {
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      parts.push(`<path d="M${cx},${n.y} L${n.x + n.w},${cy} L${cx},${n.y + n.h} L${n.x},${cy} Z" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"/>`);
    } else {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"/>`);
    }
    const lines = Array.isArray(n.label) ? n.label : [n.label];
    const fs1 = n.fs ?? 14.5;
    const lh = fs1 + 4;
    const total = lines.length * lh;
    let ty = n.y + n.h / 2 - total / 2 + fs1;
    for (let i = 0; i < lines.length; i++) {
      const fs = i === 0 ? fs1 : (n.fs2 ?? 12);
      const fill = i === 0 ? C.ink : C.sub;
      const weight = i === 0 ? 600 : 400;
      parts.push(`<text x="${n.x + n.w / 2}" y="${ty}" text-anchor="middle" font-family="${FONT}" font-size="${fs}" font-weight="${weight}" fill="${fill}">${esc(lines[i])}</text>`);
      ty += lh + (i === 0 ? 2 : 2.5);
    }
  }

  if (notes) {
    for (const t of notes) {
      parts.push(`<text x="${t.x}" y="${t.y}" font-family="${FONT}" font-size="12" fill="${C.sub}">${esc(t.text)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------- drawio 输出 ----------
const DIO_STYLE = {
  process: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.processFill};strokeColor=${C.processStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  ok: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.okFill};strokeColor=${C.okStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  warn: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.warnFill};strokeColor=${C.warnStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  bad: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.badFill};strokeColor=${C.badStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  mute: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.muteFill};strokeColor=${C.muteStroke};fontColor=${C.ink};fontSize=12;`,
  note: `rounded=1;whiteSpace=wrap;html=1;fillColor=${C.noteFill};strokeColor=${C.noteStroke};fontColor=${C.sub};fontSize=11;dashed=1;`,
  start: `rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=${C.muteFill};strokeColor=${C.muteStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  decision: `rhombus;whiteSpace=wrap;html=1;fillColor=${C.processFill};strokeColor=${C.processStroke};fontColor=${C.ink};fontSize=12;strokeWidth=1.5;`,
  container: `rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=${C.stroke};verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontColor=${C.sub};fontSize=12;`,
};

function renderDrawio(spec) {
  const cells = [];
  let i = 0;
  const id = () => 'c' + (++i);
  for (const n of spec.nodes) {
    const value = (Array.isArray(n.label) ? n.label : [n.label]).join('<br>');
    const style = DIO_STYLE[n.kind] ?? DIO_STYLE.process;
    cells.push(`<mxCell id="${n.id}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`);
  }
  for (const e of spec.edges) {
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=${C.edge};strokeWidth=1.5;fontColor=${C.sub};fontSize=11;labelBackgroundColor=#ffffff;${e.dashed ? 'dashed=1;' : ''}exitX=${{ n: 0.5, s: 0.5, w: 0, e: 1 }[e.fromSide ?? 'e']};exitY=${{ n: 0, s: 1, w: 0.5, e: 0.5 }[e.fromSide ?? 'e']};entryX=${{ n: 0.5, s: 0.5, w: 0, e: 1 }[e.toSide ?? 'w']};entryY=${{ n: 0, s: 1, w: 0.5, e: 0.5 }[e.toSide ?? 'w']};exitDx=0;exitDy=0;entryDx=0;entryDy=0;`;
    const points = e._pts ? e._pts.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('') : '';
    const geo = points
      ? `<mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array></mxGeometry>`
      : '<mxGeometry relative="1" as="geometry"/>';
    cells.push(`<mxCell id="${id()}" value="${esc(e.label ?? '')}" style="${style}" edge="1" parent="1" source="${e.from}" target="${e.to}">${geo}</mxCell>`);
  }
  return `<mxfile host="iris-docs"><diagram id="${spec.name}" name="页 1"><mxGraphModel dx="1000" dy="700" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${spec.width}" pageHeight="${spec.height}" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

// =====================================================================
// 图 1：架构总览
// =====================================================================
const architecture = {
  name: 'iris-architecture',
  title: 'Iris 架构总览（DSH 插件形态）',
  subtitle: '三个入口共用同一套动作实现；凭据与数据只留在宿主侧，插件不额外监听端口',
  width: 1180,
  height: 800,
  nodes: [
    { id: 'host', kind: 'container', x: 36, y: 96, w: 1108, h: 560, w2: 0, label: 'DeepSeek Harness 宿主进程 · Iris 插件（复用宿主工具 / 路由 / 生命周期服务）' },
    { id: 'tools', kind: 'mute', x: 66, y: 138, w: 300, h: 72, label: ['Agent 工具（14 个）', 'iris_draw_image · iris_generate_video · …'] },
    { id: 'cards', kind: 'mute', x: 440, y: 138, w: 300, h: 72, label: ['GUI 动作卡', '会话内的 Iris 操作入口'] },
    { id: 'bench', kind: 'mute', x: 790, y: 138, w: 290, h: 72, label: ['Iris 工作台（三座位）', '设置 · 进度 · 悬浮泡泡'] },
    { id: 'actions', kind: 'process', x: 200, y: 268, w: 540, h: 74, label: ['统一动作层 · lib/actions.js', '参数校验 · 输入解析（上传 / 会话附件 / 宿主路径）· failover 编排'] },
    { id: 'models', kind: 'process', x: 66, y: 396, w: 430, h: 74, label: ['模型池 · lib/models.js + capability.js', 'providerId::modelId 复合身份 · 能力分配 · 有序候选'] },
    { id: 'adapters', kind: 'process', x: 550, y: 396, w: 430, h: 74, label: ['Provider 适配 · lib/adapters.js', 'DashScope 媒体协议 · OpenAI Images 兼容'] },
    { id: 'tasks', kind: 'ok', x: 66, y: 524, w: 340, h: 74, label: ['任务系统 · lib/tasks.js', '异步轮询 · 重启恢复 · 取消传播'] },
    { id: 'files', kind: 'ok', x: 430, y: 524, w: 300, h: 74, label: ['文件与媒体 · lib/media.js', 'uploads/ outputs/ · 令牌媒体链接 · Range 流式'] },
    { id: 'client', kind: 'process', x: 790, y: 524, w: 290, h: 74, label: ['Web 客户端 · lib/client.js', '三座位 UI · 共享状态订阅 + SSE'] },
    { id: 'skillreg', kind: 'mute', x: 790, y: 268, w: 290, h: 74, label: ['Skill registry', '随包注册 iris-verify-ui / iris-compose-media'] },
    { id: 'datanote', kind: 'note', x: 66, y: 690, w: 470, h: 56, label: ['本地数据 · $DSH_HOME/iris/v1/', 'providers.json · tasks.json · uploads/ · outputs/（POSIX 0700 / 0600）'] },
    { id: 'providers', kind: 'mute', x: 580, y: 706, w: 560, h: 64, label: ['媒体 / 视觉服务商', 'DashScope 百炼 · OpenAI Images 兼容服务（凭据只发往官方 HTTPS 域名）'] },
  ],
  edges: [
    { from: 'tools', to: 'actions', fromSide: 's', toSide: 'n', toFrac: 0.2 },
    { from: 'cards', to: 'actions', fromSide: 's', toSide: 'n', toFrac: 0.5 },
    { from: 'bench', to: 'actions', fromSide: 's', fromFrac: 0.2, toSide: 'n', toFrac: 1 },
    { from: 'actions', to: 'models', fromSide: 's', toSide: 'n', fromFrac: 0.3, toFrac: 0.5, label: '选择候选模型' },
    { from: 'actions', to: 'adapters', fromSide: 's', toSide: 'n', fromFrac: 0.7, toFrac: 0.5 },
    { from: 'models', to: 'adapters', fromSide: 'e', toSide: 'w' },
    { from: 'actions', to: 'tasks', fromSide: 's', toSide: 'n', fromFrac: 0.6, toFrac: 0.5, mid: { y: 480 }, label: '创建任务', lx: 382, ly: 498 },
    { from: 'tasks', to: 'files', fromSide: 'e', toSide: 'w' },
    { from: 'tasks', to: 'client', fromSide: 's', toSide: 's', fromFrac: 0.5, toFrac: 0.5, dashed: true, via: [{ x: 236, y: 640 }, { x: 935, y: 640 }], label: '状态事件', lx: 380, ly: 630 },
    { from: 'bench', to: 'skillreg', fromSide: 's', toSide: 'n', dashed: true },
    { from: 'adapters', to: 'providers', fromSide: 's', toSide: 'n', fromFrac: 0.5, toFrac: 0.5, mid: { y: 676 }, label: 'HTTPS', lx: 812, ly: 676 },
  ],
};

// =====================================================================
// 图 2：任务生命周期与受理边界
// =====================================================================
const lifecycle = {
  name: 'iris-task-lifecycle',
  title: '生成任务生命周期与受理边界',
  subtitle: 'failover 只发生在上传 / 提交 / 同步生成阶段；远端一旦受理，绝不自动重提',
  width: 1240,
  height: 740,
  nodes: [
    { id: 'start', kind: 'start', x: 40, y: 300, w: 180, h: 60, label: ['Agent 工具 / GUI 动作卡', '提交生成请求'] },
    { id: 'create', kind: 'process', x: 268, y: 300, w: 180, h: 60, label: ['创建本地任务', 'status = running'] },
    { id: 'attempt', kind: 'warn', x: 496, y: 298, w: 220, h: 64, label: ['提交供应商（Attempt）', '上传 · 提交 · 同步生成'] },
    { id: 'decide', kind: 'decision', x: 764, y: 280, w: 180, h: 100, label: ['远端受理？'] },
    { id: 'accepted', kind: 'ok', x: 996, y: 300, w: 200, h: 60, label: ['已受理', 'remoteTaskId 落盘'] },
    { id: 'failover', kind: 'bad', x: 496, y: 140, w: 220, h: 58, label: ['failover：切换下一候选模型'] },
    { id: 'exhausted', kind: 'bad', x: 240, y: 141, w: 200, h: 56, label: ['候选耗尽', '任务失败'] },
    { id: 'watch', kind: 'process', x: 700, y: 440, w: 240, h: 56, label: ['后台轮询盯守', '重启后自动接管 running 任务'] },
    { id: 'succeeded', kind: 'ok', x: 700, y: 560, w: 240, h: 60, label: ['succeeded', '产物转存 DSH 附件 + 令牌媒体链接'] },
    { id: 'failed', kind: 'bad', x: 460, y: 560, w: 190, h: 60, label: ['failed', '保留错误说明'] },
    { id: 'canceled', kind: 'mute', x: 230, y: 560, w: 180, h: 60, label: ['canceled', '取消信号传播'] },
    { id: 'note1', kind: 'note', x: 40, y: 650, w: 560, h: 64, label: ['黄金规则：远端受理后绝不自动重提', '重提只发生在提交阶段的模型候选切换，避免重复计费'] },
    { id: 'note2', kind: 'note', x: 640, y: 650, w: 556, h: 64, label: ['启动恢复与取消', '有 remoteTaskId 的任务继续盯守；孤儿提交清理为 failed；取消传播到本地等待与轮询'] },
  ],
  edges: [
    { from: 'start', to: 'create', fromSide: 'e', toSide: 'w' },
    { from: 'create', to: 'attempt', fromSide: 'e', toSide: 'w' },
    { from: 'attempt', to: 'decide', fromSide: 'e', toSide: 'w' },
    { from: 'decide', to: 'accepted', fromSide: 'e', toSide: 'w', label: '是' },
    { from: 'decide', to: 'failover', fromSide: 'n', toSide: 'e', mid: { y: 169 }, label: '否' },
    { from: 'failover', to: 'attempt', fromSide: 's', toSide: 'n', label: '重试提交' },
    { from: 'failover', to: 'exhausted', fromSide: 'w', toSide: 'e' },
    { from: 'accepted', to: 'watch', fromSide: 's', toSide: 'e', mid: { x: 1096, y: 468 }, label: '转入盯守' },
    { from: 'watch', to: 'succeeded', fromSide: 's', toSide: 'n', fromFrac: 0.5, toFrac: 0.5 },
    { from: 'watch', to: 'failed', fromSide: 's', toSide: 'n', fromFrac: 0.25, toFrac: 0.5, mid: { y: 534 }, dashed: true },
    { from: 'watch', to: 'canceled', fromSide: 'w', toSide: 'n', dashed: true, via: [{ x: 660, y: 468 }, { x: 660, y: 524 }, { x: 320, y: 524 }], lx: 490, ly: 518, label: '轮询耗尽 / 取消 / 错误' },
  ],
};

// =====================================================================
// 图 3：组合工作流示例（iris-compose-media）
// =====================================================================
const workflow = {
  name: 'iris-workflow-compose',
  title: '组合工作流示例：看图 → 重绘 → 自检',
  subtitle: '来自随包 Skill「iris-compose-media」：先理解，再生成，复核针对具体偏差，重试有界',
  width: 1150,
  height: 500,
  nodes: [
    { id: 'src', kind: 'start', x: 40, y: 116, w: 190, h: 66, label: ['源图片', '宿主路径 / 会话附件'] },
    { id: 'look', kind: 'process', x: 280, y: 116, w: 250, h: 66, label: ['iris_look_at_image', '结构化观察：主体 · 构图 · 色彩 · 文字'] },
    { id: 'prompt', kind: 'process', x: 580, y: 116, w: 250, h: 66, label: ['生成自包含提示词', '区分原图事实与本次改动要求'] },
    { id: 'draw', kind: 'warn', x: 880, y: 116, w: 230, h: 66, label: ['iris_draw_image', '付费步骤 · 按产物数计'] },
    { id: 'review', kind: 'process', x: 880, y: 286, w: 230, h: 66, label: ['iris_relook_attachment', '对照原始需求逐项复核'] },
    { id: 'decide', kind: 'decision', x: 600, y: 272, w: 180, h: 94, label: ['与需求一致？'] },
    { id: 'deliver', kind: 'ok', x: 320, y: 278, w: 220, h: 82, label: ['交付产物', 'attachment id + 任务记录 + 媒体链接'] },
    { id: 'note1', kind: 'note', x: 40, y: 408, w: 1070, h: 40, label: ['纪律：只在缺失会改变结果时提问；复核不通过才重绘；生成前明确用途与比例；保留 attachment id 与任务记录供后续步骤复用'] },
  ],
  edges: [
    { from: 'src', to: 'look', fromSide: 'e', toSide: 'w' },
    { from: 'look', to: 'prompt', fromSide: 'e', toSide: 'w' },
    { from: 'prompt', to: 'draw', fromSide: 'e', toSide: 'w' },
    { from: 'draw', to: 'review', fromSide: 's', toSide: 'n', label: '需要复核' },
    { from: 'review', to: 'decide', fromSide: 'w', toSide: 'e' },
    { from: 'decide', to: 'deliver', fromSide: 'w', toSide: 'e', label: '一致' },
    { from: 'decide', to: 'prompt', fromSide: 'n', toSide: 's', mid: { y: 232 }, dashed: true, label: '不一致 · 仅针对具体偏差重生成', lx: 700, ly: 232 },
  ],
};

// ---------- 产出 ----------
const SPECS = [architecture, lifecycle, workflow];
for (const spec of SPECS) {
  const svg = renderSvg(spec);
  const drawio = renderDrawio(spec);
  fs.writeFileSync(path.join(OUT, `${spec.name}.svg`), svg);
  fs.writeFileSync(path.join(OUT, `${spec.name}.drawio`), drawio);
  await sharp(Buffer.from(svg), { density: 192 }).png().toFile(path.join(OUT, `${spec.name}.png`));
  console.log('done:', spec.name);
}
