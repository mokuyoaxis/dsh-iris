import fs from 'node:fs';
import path from 'node:path';

// IRIS 视觉资产生成：历史像素鸢尾花 / 3×5 字形，以及 0.3.0 README 自适应矢量英雄组合标志。
// 源数据即本文件；`node scripts/gen-logo.mjs` 复现 docs/assets/logo/*.svg（`--wordmark-only` 仅更新 README 组合标志）。

const OUT = path.resolve(process.cwd(), 'docs/assets/logo');

const PALETTE = {
  bloom: '#8C77EE', // 顶部旗瓣（standards）
  fall: '#3F32A8', // 两侧垂瓣（falls）
  heart: '#F0B23E', // 花心（beard，垂瓣汇聚处的竖条）
  stem: '#4A9E6F', // 花茎
  ink: '#1E1E24', // 单色墨（浅底）
  paper: '#F5F3FF', // 反白（深底）
  letter: '#26204F' // 字标（浅底深紫，与垂瓣拉开层级）
};

// 鸢尾图形标：9 列 × 10 行。B=旗瓣 F=垂瓣 H=花心 S=茎
const MARK = [
  '....B....',
  '...BBB...',
  '..BBBBB..',
  '..BBBBB..',
  'F..BBB..F',
  'FF.BHB.FF',
  '.FF.H.FF.',
  '..FFSFF..',
  '....S....',
  '....S....'
];
const PART_FILL = { B: 'bloom', F: 'fall', H: 'heart', S: 'stem' };

// 3×5 像素字
const LETTERS = {
  I: ['111', '010', '010', '010', '111'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '011', '001', '110']
};

const CELL = 8;
const GAP = 2; // 图形标与字标之间的空格数
const MARK_W = 9, MARK_H = 10;
const WORD = 'IRIS';
const WORD_COLS = 4 * WORD.length - 1; // 3 列/字 + 1 列间距
const WORD_X = (MARK_W + GAP) * CELL;
const WORD_Y = Math.floor((MARK_H - 5) / 2) * CELL;

function rectsForMark(colorOf) {
  const out = [];
  MARK.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      out.push({ x: x * CELL, y: y * CELL, fill: colorOf(PART_FILL[ch]) });
    });
  });
  return out;
}

function rectsForWord(colorOf) {
  const out = [];
  let col = 0;
  for (const ch of WORD) {
    const grid = LETTERS[ch];
    grid.forEach((row, y) => {
      [...row].forEach((v, x) => {
        if (v === '1') out.push({ x: WORD_X + (col + x) * CELL, y: WORD_Y + y * CELL, fill: colorOf('letter') });
      });
    });
    col += 4;
  }
  return out;
}

function svg({ width, height, title, desc, rects, pad = 0, cellSize = CELL }) {
  const vb = pad ? `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}` : `0 0 ${width} ${height}`;
  const body = rects.map((r) =>
    `  <rect x="${r.x}" y="${r.y}" width="${cellSize}" height="${cellSize}" fill="${r.fill}"/>`
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + pad * 2}" height="${height + pad * 2}" viewBox="${vb}" role="img" aria-label="${title}" shape-rendering="crispEdges">
  <title>${title}</title>
  <desc>${desc}</desc>
${body}
</svg>
`;
}

const LOGO_W = (MARK_W + GAP + WORD_COLS) * CELL;
const LOGO_H = MARK_H * CELL;

const variants = {
  'iris-logo.svg': {
    title: 'IRIS 标志（彩色）',
    desc: '像素块鸢尾花与 IRIS 像素字标，浅底色适用',
    rects: [...rectsForMark((part) => PALETTE[part]), ...rectsForWord(() => PALETTE.letter)]
  },
  'iris-logo-mono.svg': {
    title: 'IRIS 标志（单色）',
    desc: '像素块鸢尾花与 IRIS 像素字标，单色墨，浅底色适用',
    rects: [...rectsForMark(() => PALETTE.ink), ...rectsForWord(() => PALETTE.ink)]
  },
  'iris-logo-mono-inverse.svg': {
    title: 'IRIS 标志（单色反白）',
    desc: '像素块鸢尾花与 IRIS 像素字标，反白，深底色适用',
    rects: [...rectsForMark(() => PALETTE.paper), ...rectsForWord(() => PALETTE.paper)]
  },
  'iris-mark.svg': {
    title: 'IRIS 图形标（彩色）',
    desc: '像素块鸢尾花图形标，带一格留白，紧凑图标与 App 角标适用',
    rects: rectsForMark((part) => PALETTE[part]),
    mark: true
  },
  'iris-mark-mono.svg': {
    title: 'IRIS 图形标（单色）',
    desc: '像素块鸢尾花图形标，单色墨',
    rects: rectsForMark(() => PALETTE.ink),
    mark: true
  },
  'iris-mark-mono-inverse.svg': {
    title: 'IRIS 图形标（单色反白）',
    desc: '像素块鸢尾花图形标，反白',
    rects: rectsForMark(() => PALETTE.paper),
    mark: true
  }
};

fs.mkdirSync(OUT, { recursive: true });
const wordmarkOnly = process.argv.includes('--wordmark-only');
for (const [name, v] of Object.entries(wordmarkOnly ? {} : variants)) {
  const width = v.mark ? MARK_W * CELL : LOGO_W;
  const height = v.mark ? MARK_H * CELL : LOGO_H;
  fs.writeFileSync(path.join(OUT, name), svg({ width, height, title: v.title, desc: v.desc, rects: v.rects, pad: v.mark ? CELL : 0 }));
  console.log('wrote', name, `${width + (v.mark ? CELL * 2 : 0)}x${height + (v.mark ? CELL * 2 : 0)}`);
}

// 0.3.0 README 矢量英雄标志组合：对称光学环抱弧 + 多层渐变鸢尾花 + 定制几何人文 "Iris." 字标，
// 分别生成浅色/通用版（iris-wordmark.svg）与深色背景版（iris-wordmark-dark.svg）。
const WORDMARK_RADIUS = 55;
const WORDMARK_ARC_X = (WORDMARK_RADIUS * Math.cos(46 * Math.PI / 180)).toFixed(2);
const WORDMARK_ARC_Y = (WORDMARK_RADIUS * Math.sin(46 * Math.PI / 180)).toFixed(2);

function wordmarkTheme(dark) {
  return dark
    ? {
        suffix: '（深色底）',
        descSuffix: '（适配深色背景）',
        haloA: '#8F7CF6', haloAOp: '0.26', haloB: '#D284BF', haloBOp: '0.09', haloBg: '#0D1117',
        ringLA: '#A59BFF', ringLB: '#9388F2', ringLC: '#C685BA', ringEdgeOp: '0.18', ringLOp: '0.58',
        ringRA: '#DF92BA', ringRB: '#F2BA86', ringRC: '#F4D59D', ringROp: '0.62',
        dotL: '#9B90F8', dotLOp: '0.85', dotR: '#F2C185', dotROp: '0.88',
        stdL: ['#CFC3FF', '#6657BF'], stdR: ['#E2B6F2', '#735BC2'],
        stdC: ['#FBF8FF', '#C2B4FF', '#6654BC'], sheenOp: '0.55', crownStroke: '',
        fallL: ['#8A7AE2', '#5D48AC', '#9B63AC'], fallR: ['#BD80CE', '#6E4CB0', '#CE7D9F'],
        fallC: ['#AEA1F5', '#6E56BC', '#CA83B9'],
        leafL: ['#99DBC2', '#4B8E77'], leafR: ['#B0E6CF', '#579F86'],
        text: ['#FFFFFF', '#EFEAFF', '#C6BCFA']
      }
    : {
        suffix: '',
        descSuffix: '（适配浅色背景）',
        haloA: '#8A7AE0', haloAOp: '0.14', haloB: '#C989BA', haloBOp: '0.05', haloBg: '#FFFFFF',
        ringLA: '#7C74CE', ringLB: '#6A61BE', ringLC: '#BB78AD', ringEdgeOp: '0.14', ringLOp: '0.46',
        ringRA: '#C880B2', ringRB: '#E59B76', ringRC: '#EDC288', ringROp: '0.52',
        dotL: '#6A61BE', dotLOp: '0.85', dotR: '#E59B76', dotROp: '0.88',
        stdL: ['#A69AED', '#5242A3'], stdR: ['#BC8EDC', '#5D49A7'],
        stdC: ['#DDD3FF', '#9080E4', '#4C3A95'], sheenOp: '0.68',
        crownStroke: ' stroke="#7E6FD8" stroke-opacity="0.28" stroke-width="0.65"',
        fallL: ['#6E63BE', '#45317D', '#734B93'], fallR: ['#9A6DBA', '#4F388C', '#9C6291'],
        fallC: ['#8578D4', '#4D3993', '#9A63A4'],
        leafL: ['#6EB49B', '#3C7762'], leafR: ['#88C5AF', '#478670'],
        text: ['#25194D', '#45317D', '#6A61B4']
      };
}

function renderWordmarkSvg(dark) {
  const t = wordmarkTheme(dark);
  const stop3 = (id, x1, y1, x2, y2, [a, b, c]) =>
    `    <linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">\n` +
    `      <stop offset="0%" stop-color="${a}"/>\n      <stop offset="52%" stop-color="${b}"/>\n      <stop offset="100%" stop-color="${c}"/>\n    </linearGradient>`;
  const stop2 = (id, x1, y1, x2, y2, [a, b]) =>
    `    <linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">\n` +
    `      <stop offset="0%" stop-color="${a}"/>\n      <stop offset="100%" stop-color="${b}"/>\n    </linearGradient>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="310" height="138" viewBox="0 0 310 138" role="img" aria-label="Iris">
  <title>Iris${t.suffix}</title>
  <desc>Iris 多模态工作区标志与字标${t.descSuffix}</desc>
  <defs>
    <radialGradient id="irisHalo" cx="50%" cy="46%" r="50%">
      <stop offset="0%" stop-color="${t.haloA}" stop-opacity="${t.haloAOp}"/>
      <stop offset="56%" stop-color="${t.haloB}" stop-opacity="${t.haloBOp}"/>
      <stop offset="100%" stop-color="${t.haloBg}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="irisRingL" x1="-54" y1="-34" x2="-24" y2="42" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.ringLA}" stop-opacity="${t.ringEdgeOp}"/>
      <stop offset="50%" stop-color="${t.ringLB}" stop-opacity="${t.ringLOp}"/>
      <stop offset="100%" stop-color="${t.ringLC}" stop-opacity="${t.ringEdgeOp}"/>
    </linearGradient>
    <linearGradient id="irisRingR" x1="54" y1="-34" x2="24" y2="42" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.ringRA}" stop-opacity="${t.ringEdgeOp}"/>
      <stop offset="50%" stop-color="${t.ringRB}" stop-opacity="${t.ringROp}"/>
      <stop offset="100%" stop-color="${t.ringRC}" stop-opacity="${t.ringEdgeOp}"/>
    </linearGradient>
${stop2('irisStdSideL', -34, -36, 0, 6, t.stdL)}
${stop2('irisStdSideR', 34, -36, 0, 6, t.stdR)}
${stop3('irisStdCenter', 0, -45, 0, 10, t.stdC)}
    <linearGradient id="irisStdSheen" x1="0" y1="-44" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="${t.sheenOp}"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
${stop3('irisFallL', -42, 2, -4, 28, t.fallL)}
${stop3('irisFallR', 42, 2, 4, 28, t.fallR)}
${stop3('irisFallCenter', 0, 0, 0, 40, t.fallC)}
${stop2('irisLeafL', -30, 20, 0, 47, t.leafL)}
${stop2('irisLeafR', 30, 20, 0, 47, t.leafR)}
${stop3('irisHeartOuter', 0, -6, 0, 17, ['#FFF7E2', '#F2CA82', '#E48E68'])}
    <linearGradient id="irisHeartInner" x1="0" y1="-2" x2="0" y2="11" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.96"/>
      <stop offset="100%" stop-color="#FFF0C4" stop-opacity="0.35"/>
    </linearGradient>
${stop3('irisTextGrad', 0, 0, 145, 72, t.text)}
${stop3('irisSparkGrad', 60, -2, 80, 15, ['#B975AE', '#DF8E7F', '#EDA87A'])}
${stop3('irisDotGrad', 133, 59, 146, 72, ['#E59B76', '#ECAC82', '#F0D09C'])}
  </defs>
  <g transform="translate(71, 69)">
    <circle cx="0" cy="0" r="60" fill="url(#irisHalo)"/>
    <path d="M-${WORDMARK_ARC_X} ${WORDMARK_ARC_Y} A${WORDMARK_RADIUS} ${WORDMARK_RADIUS} 0 0 1 -${WORDMARK_ARC_X} -${WORDMARK_ARC_Y}" fill="none" stroke="url(#irisRingL)" stroke-width="1.35" stroke-linecap="round"/>
    <path d="M${WORDMARK_ARC_X} -${WORDMARK_ARC_Y} A${WORDMARK_RADIUS} ${WORDMARK_RADIUS} 0 0 1 ${WORDMARK_ARC_X} ${WORDMARK_ARC_Y}" fill="none" stroke="url(#irisRingR)" stroke-width="1.35" stroke-linecap="round"/>
    <circle cx="-${WORDMARK_RADIUS}" cy="0" r="1.95" fill="${t.dotL}" opacity="${t.dotLOp}"/>
    <circle cx="${WORDMARK_RADIUS}" cy="0" r="1.95" fill="${t.dotR}" opacity="${t.dotROp}"/>
    <path d="M-2 22 L2 22 L2.1 45.5 C2.1 47 -2.1 47 -2.1 45.5 Z" fill="url(#irisLeafL)"/>
    <path d="M-1 45.5 C-15 44 -26 36 -28.5 22 C-18.5 24 -8.5 31.5 -1 42 Z" fill="url(#irisLeafL)"/>
    <path d="M1 45.5 C15 44 26 36 28.5 22 C18.5 24 8.5 31.5 1 42 Z" fill="url(#irisLeafR)"/>
    <path d="M-2.5 5 C-20 3 -33 -12 -26.5 -31.5 C-12 -31.5 -2 -16 -1.5 3 Z" fill="url(#irisStdSideL)"/>
    <path d="M2.5 5 C20 3 33 -12 26.5 -31.5 C12 -31.5 2 -16 1.5 3 Z" fill="url(#irisStdSideR)"/>
    <path d="M0 -45.5 C-13 -30 -13.5 -12 -1.5 6.5 L1.5 6.5 C13.5 -12 13 -30 0 -45.5 Z" fill="url(#irisStdCenter)"${t.crownStroke}/>
    <path d="M0 -42 C-5.5 -28 -5.5 -14 -0.5 1 L0 -42 Z" fill="url(#irisStdSheen)" opacity="0.58"/>
    <path d="M-1.5 4 C-16.5 -6.5 -38.5 -1 -41.5 16 C-42.5 25 -35 32.5 -30.5 33.5 C-32 26 -28 18 -18 18 C-9.5 18 -3.5 23.5 -1.5 12 Z" fill="url(#irisFallL)"/>
    <path d="M1.5 4 C16.5 -6.5 38.5 -1 41.5 16 C42.5 25 35 32.5 30.5 33.5 C32 26 28 18 18 18 C9.5 18 3.5 23.5 1.5 12 Z" fill="url(#irisFallR)"/>
    <path d="M0 1.5 C-14.5 8 -16 26.5 0 39.5 C16 26.5 14.5 8 0 1.5 Z" fill="url(#irisFallCenter)"/>
    <path d="M0 -5.5 C-5.6 -0.8 -7.2 6.2 -3 12.2 L0 17 L3 12.2 C7.2 6.2 5.6 -0.8 0 -5.5 Z" fill="url(#irisHeartOuter)"/>
    <path d="M0 -1.5 C-2.8 1.5 -3.4 5.5 -1.2 9 L0 11.2 L1.2 9 C3.4 5.5 2.8 1.5 0 -1.5 Z" fill="url(#irisHeartInner)"/>
  </g>
  <g transform="translate(148, 33)">
    <g fill="url(#irisTextGrad)">
      <rect x="0" y="0" width="11.4" height="72" rx="2.2"/>
      <path d="M23.5 23.2 C23.5 21.8 24.5 21 26 21 L32.6 21 C34 21 34.8 21.9 35 23.6 L35 27.5 C37.8 22.3 42.3 19.8 48.2 19.8 C50.5 19.8 52.3 20.3 53.6 21.1 L51.0 31.3 C49.5 30.5 47.8 30.1 45.7 30.1 C39.2 30.1 35 35.4 35 44.2 L35 69.8 C35 71.2 34 72 32.5 72 L25.7 72 C24.3 72 23.5 71.1 23.5 69.8 Z"/>
      <rect x="63.2" y="21" width="11.4" height="51" rx="2.2"/>
      <path d="M106.8 19.6 C117.2 19.6 124.5 24.4 126.1 32.5 C126.3 33.7 125.5 34.5 124.3 34.7 L117.0 36.1 C115.9 36.3 115.1 35.7 114.8 34.5 C113.5 30.3 110.3 28.4 106.0 28.4 C101.0 28.4 97.8 30.5 97.8 33.7 C97.8 37.1 100.9 38.6 108.2 40.4 L111.4 41.2 C121.8 43.8 127.4 48.2 127.4 56.2 C127.4 66.2 119.0 73.2 106.2 73.2 C94.0 73.2 86.2 67.6 84.6 58.6 C84.4 57.5 85.1 56.6 86.3 56.4 L93.8 55.0 C94.9 54.8 95.7 55.4 96.0 56.6 C97.4 61.5 101.1 64.2 106.5 64.2 C112.2 64.2 115.8 61.8 115.8 58.2 C115.8 54.6 112.7 52.8 104.9 50.9 L101.8 50.1 C91.8 47.6 86.4 43.2 86.4 35.2 C86.4 25.8 94.4 19.6 106.8 19.6 Z"/>
    </g>
    <path d="M68.9 -0.4 C70.0 4.2 71.5 5.7 76.1 6.8 C71.5 7.9 70.0 9.4 68.9 14.0 C67.8 9.4 66.3 7.9 61.7 6.8 C66.3 5.7 67.8 4.2 68.9 -0.4 Z" fill="url(#irisSparkGrad)"/>
    <circle cx="139.6" cy="66.2" r="5.8" fill="url(#irisDotGrad)"/>
  </g>
</svg>
`;
}

for (const [filename, dark] of [['iris-wordmark.svg', false], ['iris-wordmark-dark.svg', true]]) {
  fs.writeFileSync(path.join(OUT, filename), renderWordmarkSvg(dark));
  console.log('wrote', filename, '310x138');
}
