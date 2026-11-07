/**
 * 方块定义与贴图图集
 *
 * 数据来自原版 0.44.2 的 blockdef.csv（756 个方块）：
 *   data/blocks.json   — 方块属性 + 贴图槽顺序
 *   textures/blocks/all/*.png — 原版贴图
 *
 * 图集布局：4096×4096，32×32 格，每格 128px（112px 纹理 + 8px 扩边）。
 * 扩边是为了 mipmap 采样时不混到隔壁格子的颜色。
 */

const TILE = 112;        // 每格实际纹理边长
const PAD = 8;           // 四周扩边
const CELL = TILE + PAD * 2;      // 128
const ATLAS_GRID = 32;
const ATLAS_SIZE = CELL * ATLAS_GRID;   // 4096

const MAX_ID = 1024;

// 这些数组在模块加载时就创建好，world.js 顶层会直接引用它们，
// 数据填进去之后内容才有效 —— 引用不变，所以不用重建。
const BLOCKS = [];
const BLOCK_BY_ID = {};
const SOLID = new Uint8Array(MAX_ID);
const OPAQUE = new Uint8Array(MAX_ID);
const HARDNESS = new Float32Array(MAX_ID);
const BURNING = new Uint8Array(MAX_ID);
const LIGHTNESS = new Uint8Array(MAX_ID);
const TILE_TOP = new Uint16Array(MAX_ID);
const TILE_SIDE = new Uint16Array(MAX_ID);
const TILE_BOTTOM = new Uint16Array(MAX_ID);
const OVERLAY = new Int16Array(MAX_ID).fill(-1);
const GEOM_NAME = new Array(MAX_ID).fill('');
const GEOM_OF = new Uint8Array(MAX_ID);   // 方块 id → 几何编号（0 = 立方体，n = GEOM_LIST[n-1]）
const PANE = new Uint8Array(MAX_ID);     // 1 = 玻璃板类，几何由程序按邻居生成
const SND_WALK = new Array(MAX_ID).fill('');   // 走路音类别（stone / wood / grass …）
const SND_DIG = new Array(MAX_ID).fill('');    // 挖掘音类别
const MAP_COLOR = new Array(MAX_ID).fill('#808080');

// 挖掘耗时直接存在 blocks.json 里（秒），这里保留系数给老代码用
const DIG_FACTOR = 1.0;

let TEX_SLOTS = [];        // 贴图名 → 图集格号
let PLACEABLE = [];
let ATLAS_READY = false;
// 真实加载进度（0-1），main.js 的进度条读它
let LOAD_PROGRESS = 0;
window.__atlasProgress = 0;

// ---------------------------------------------------------------- 加载

let _dataPromise = null;

function loadBlockData() {
  if (_dataPromise) return _dataPromise;

  _dataPromise = fetch('./data/blocks.json')
    .then((r) => {
      if (!r.ok) throw new Error('blocks.json ' + r.status);
      return r.json();
    })
    .then((d) => {
      TEX_SLOTS = d.textures || [];

      d.blocks.forEach((b) => {
        const id = b.id;
        const solid = b.c === 1;
        const liquid = b.c === 2;

        const def = {
          id,
          name: b.name,
          en: b.en,
          cat: b.cat,
          orig: b.orig,
          solid,
          liquid,
          transparent: !b.p || liquid,
          hardness: b.h,
          lightness: b.l,
          geom: b.g || '',
          mapColor: b.mc,
        };

        BLOCKS.push(def);
        BLOCK_BY_ID[id] = def;

        SOLID[id] = solid ? 1 : 0;
        // 遮挡判定：不透明的实心块才挡邻居的面
        OPAQUE[id] = (solid && b.p) ? 1 : 0;
        HARDNESS[id] = b.h;
        LIGHTNESS[id] = b.l || 0;
        TILE_TOP[id] = b.t[0];
        TILE_SIDE[id] = b.t[1];
        TILE_BOTTOM[id] = b.t[2];
        OVERLAY[id] = b.o;
        GEOM_NAME[id] = b.g || '';
        // 玻璃片没有可用的 OBJ，用程序生成的薄板，才能做连接判定
        PANE[id] = (b.cat === 'glasspane') ? 1 : 0;
        SND_WALK[id] = b.sw || '';
        SND_DIG[id] = b.sd || '';
        MAP_COLOR[id] = '#' + (b.mc || '808080');
      });

      // 默认快捷栏：挑九个最常见的
      const want = ['草块', '土块', '石头', '沙子', '果木', '果木板', '玻璃块', '石砖', '水'];
      const picked = [];
      want.forEach((n) => {
        const hit = BLOCKS.find((b) => b.name === n && picked.indexOf(b.id) < 0);
        if (hit) picked.push(hit.id);
      });
      // 补齐到 9 个
      for (let i = 0; picked.length < 9 && i < BLOCKS.length; i++) {
        const b = BLOCKS[i];
        if (picked.indexOf(b.id) < 0 && b.solid) picked.push(b.id);
      }
      PLACEABLE = picked;
      window.PLACEABLE = PLACEABLE;

      LOAD_PROGRESS = 0.08;
      window.__atlasProgress = LOAD_PROGRESS;
      console.log('[方块] 载入 ' + BLOCKS.length + ' 个，贴图槽 ' + TEX_SLOTS.length + ' 个');
      return d;
    })
    .then((d) => loadGeometry(d));

  return _dataPromise;
}

// ---------------------------------------------------------------- 几何模型

function b64ToF32(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

function b64ToU16(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Uint16Array(buf.buffer);
}

async function loadGeometry(blockData) {
  let raw = {};
  try {
    const r = await fetch('./data/geometry.json');
    if (r.ok) raw = await r.json();
  } catch {
    console.warn('[几何] geometry.json 加载失败，模型方块将按立方体渲染');
  }

  const names = Object.keys(raw);
  const order = {};
  names.forEach((n, i) => { order[n] = i + 1; });

  const list = names.map((n) => {
    const g = raw[n];
    const inter = b64ToF32(g.v);        // [x,y,z,u,v] 交错
    const count = g.n;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = inter[i * 5];
      pos[i * 3 + 1] = inter[i * 5 + 1];
      pos[i * 3 + 2] = inter[i * 5 + 2];
      uv[i * 2] = inter[i * 5 + 3];
      uv[i * 2 + 1] = inter[i * 5 + 4];
    }
    return { pos, uv, idx: b64ToU16(g.i) };
  });

  if (window.BLOCKS) {
    window.BLOCKS.forEach((b) => {
      GEOM_OF[b.id] = b.geom ? (order[b.geom] || 0) : 0;
    });
  }

  LOAD_PROGRESS = 0.15;
  window.__atlasProgress = LOAD_PROGRESS;
  window.GEOM_LIST = list;
  const used = BLOCKS.filter((b) => GEOM_OF[b.id]).length;
  console.log('[几何] ' + list.length + ' 个模型，' + used + ' 个方块使用');
  return blockData;
}

// ---------------------------------------------------------------- 图集

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function expandEdges(ctx, ox, oy) {
  const cv = ctx.canvas;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, ox, oy, TILE, 1, ox - PAD, oy - PAD, TILE, PAD);
  ctx.drawImage(cv, ox, oy + TILE - 1, TILE, 1, ox - PAD, oy + TILE, TILE, PAD);
  ctx.drawImage(cv, ox, oy - PAD, 1, CELL, ox - PAD, oy - PAD, PAD, CELL);
  ctx.drawImage(cv, ox + TILE - 1, oy - PAD, 1, CELL, ox + TILE, oy - PAD, PAD, CELL);
}

function blankTile(ctx, gx, gy) {
  const ox = gx * CELL + PAD;
  const oy = gy * CELL + PAD;
  const s = TILE / 2;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#c020c0' : '#402040';
      ctx.fillRect(ox + x * s, oy + y * s, s, s);
    }
  }
}

async function buildAtlas() {
  const data = await loadBlockData();

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;      // 128 → 112 缩一点，平滑更自然

  // 分批并发加载，避免 537 个请求同时打出去
  const names = TEX_SLOTS;
  const imgs = new Array(names.length).fill(null);
  const BATCH = 32;

  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH);
    const got = await Promise.all(
      slice.map((n) => loadImage('./textures/blocks/all/' + n + '.png'))
    );
    got.forEach((img, k) => { imgs[i + k] = img; });
    LOAD_PROGRESS = 0.15 + 0.7 * Math.min(1, (i + slice.length) / names.length);
    window.__atlasProgress = LOAD_PROGRESS;
  }

  let ok = 0;
  let missing = 0;

  names.forEach((name, slot) => {
    const gx = slot % ATLAS_GRID;
    const gy = (slot / ATLAS_GRID) | 0;
    const ox = gx * CELL + PAD;
    const oy = gy * CELL + PAD;

    // 图集格子用完就跳过（理论上不会，537 < 1024）
    if (gy >= ATLAS_GRID) return;

    const img = imgs[slot];
    if (img) {
      // 有些贴图是竖条序列帧：water 是 64×2560（40 帧）、火炉/箱子 128×256（2 帧）、
      // 熔岩 64×1024（16 帧）。整张压进一格会变成一片密集横纹 —— 水面那种"放射拉丝"就是这么来的。
      // 门的贴图是 128×128（上下半各有独立文件），不会被这条规则误伤。
      let sw = img.width;
      let sh = img.height;
      if (sh >= sw * 2 && sh % sw === 0) sh = sw;

      ctx.clearRect(ox - PAD, oy - PAD, CELL, CELL);
      ctx.drawImage(img, 0, 0, sw, sh, ox, oy, TILE, TILE);
      expandEdges(ctx, ox, oy);
      ok++;
    } else {
      blankTile(ctx, gx, gy);
      missing++;
    }
  });

  window.__atlasProgress = 0.9;
  canvas.customTiles = ok;
  canvas.missingTiles = missing;
  canvas.hasOverlay = true;
  ATLAS_READY = true;

  console.log('[贴图] 图集 ' + ATLAS_SIZE + 'px，成功 ' + ok + ' 张'
    + (missing ? '，缺失 ' + missing + ' 张（洋红占位）' : ''));
  return canvas;
}

// ---------------------------------------------------------------- UV

function atlasUV(slot, u, v) {
  const gx = slot % ATLAS_GRID;
  const gy = (slot / ATLAS_GRID) | 0;
  const span = TILE / ATLAS_SIZE;
  const inset = 0.5 / ATLAS_SIZE;
  const u0 = (gx * CELL + PAD) / ATLAS_SIZE;
  const v0 = (gy * CELL + PAD) / ATLAS_SIZE;
  return [
    u0 + inset + u * (span - inset * 2),
    1 - (v0 + inset + (1 - v) * (span - inset * 2)),
  ];
}

function tileOf(block, faceKind) {
  if (!block) return 0;
  if (faceKind === 'top') return TILE_TOP[block.id];
  if (faceKind === 'bottom') return TILE_BOTTOM[block.id];
  return TILE_SIDE[block.id];
}

// ---------------------------------------------------------------- 导出

window.BLOCKS = BLOCKS;
window.BLOCK_BY_ID = BLOCK_BY_ID;
window.SOLID = SOLID;
window.OPAQUE = OPAQUE;
window.HARDNESS = HARDNESS;
window.BURNING = BURNING;
window.LIGHTNESS = LIGHTNESS;
window.OVERLAY = OVERLAY;
window.GEOM_NAME = GEOM_NAME;
window.GEOM_OF = GEOM_OF;
window.PANE = PANE;
window.SND_WALK = SND_WALK;
window.SND_DIG = SND_DIG;
window.MAP_COLOR = MAP_COLOR;
window.DIG_FACTOR = DIG_FACTOR;
window.PLACEABLE = PLACEABLE;
window.TILE_TOP = TILE_TOP;
window.TILE_SIDE = TILE_SIDE;
window.TILE_BOTTOM = TILE_BOTTOM;
window.TILE = TILE;
window.ATLAS_SIZE = ATLAS_SIZE;
window.ATLAS_GRID = ATLAS_GRID;
window.ATLAS_PAD = PAD;
window.ATLAS_CELL = CELL;
window.buildAtlas = buildAtlas;
window.atlasUV = atlasUV;
window.tileOf = tileOf;
window.loadBlockData = loadBlockData;
