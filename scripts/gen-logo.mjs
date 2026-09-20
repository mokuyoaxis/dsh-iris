import fs from 'node:fs';
import path from 'node:path';

// IRIS 视觉资产生成：像素块（cell）几何母题——鸢尾花图形标 + 3×5 像素字 IRIS。
// 源数据即下方矩阵；`node scripts/gen-logo.mjs` 复现 docs/assets/logo/*.svg。

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

function svg({ width, height, title, desc, rects, pad = 0 }) {
  const vb = pad ? `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}` : `0 0 ${width} ${height}`;
  const body = rects.map((r) =>
    `  <rect x="${r.x}" y="${r.y}" width="${CELL}" height="${CELL}" fill="${r.fill}"/>`
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
for (const [name, v] of Object.entries(variants)) {
  const width = v.mark ? MARK_W * CELL : LOGO_W;
  const height = v.mark ? MARK_H * CELL : LOGO_H;
  fs.writeFileSync(path.join(OUT, name), svg({ width, height, title: v.title, desc: v.desc, rects: v.rects, pad: v.mark ? CELL : 0 }));
  console.log('wrote', name, `${width + (v.mark ? CELL * 2 : 0)}x${height + (v.mark ? CELL * 2 : 0)}`);
}
