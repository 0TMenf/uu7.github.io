/**
 * 原版内容层：统一加载与索引
 * ---------------------------------------------------------------
 * 五份 JSON 由 tools/gen_content.py 从解密 CSV 生成。
 * 脚本一加载就并行发起请求，结果挂在 window.Content.ready，
 * main.js 在读完图集后 await 它，不额外拖长首屏。
 */
(function () {
  'use strict';

  const BASE = './data/content/';
  const FILES = ['items', 'mobs', 'particles', 'recipes', 'circuits', 'models', 'mobtex'];

  function rowsToObjects(fields, rows) {
    return rows.map((r) => {
      const o = {};
      for (let i = 0; i < fields.length; i++) o[fields[i]] = r[i];
      return o;
    });
  }

  function indexBy(list, key) {
    const m = new Map();
    for (const x of list) m.set(x[key], x);
    return m;
  }

  const C = {
    ready: null,
    loaded: false,
    counts: {},
    items: [], mobs: [], particles: [], recipes: [], circuits: [], models: {},
    itemById: new Map(), mobById: new Map(), particleById: new Map(),
    circuitByBlock: new Map(), circuitByRole: new Map(),
    blockToItem: new Map(), itemToBlock: new Map(),
    mobTex: {}, presets: {}, rules: {},
    errors: [],
  };

  function iconURL(item) {
    if (!item || !item.icon) return '';
    return './textures/items/' + item.icon;
  }

  function particleTexURL(name) {
    return './textures/particles/' + name;
  }

  function mobTexURL(model, file) {
    return './textures/mobs/' + model + '/' + file;
  }

  function search(kind, q, limit) {
    const pool = C[kind] || [];
    const s = String(q || '').trim().toLowerCase();
    let out = pool;
    if (s) {
      out = pool.filter((x) =>
        (x.name || '').toLowerCase().includes(s)
        || (x.en || '').toLowerCase().includes(s)
        || String(x.id).includes(s)
      );
    }
    return limit ? out.slice(0, limit) : out;
  }

  async function load() {
    const got = {};
    await Promise.all(FILES.map(async (name) => {
      try {
        const r = await fetch(BASE + name + '.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        got[name] = await r.json();
      } catch (e) {
        // models.json / mobtex.json 是可选增强，缺了不算错误
        if (name !== 'models' && name !== 'mobtex') C.errors.push(name + ': ' + e.message);
        got[name] = null;
      }
    }));

    if (got.items) {
      C.items = rowsToObjects(got.items.fields, got.items.rows);
      C.itemById = indexBy(C.items, 'id');
    }
    if (got.mobs) {
      C.mobs = rowsToObjects(got.mobs.fields, got.mobs.rows);
      C.mobById = indexBy(C.mobs, 'id');
    }
    if (got.particles) {
      C.particles = rowsToObjects(got.particles.fields, got.particles.rows);
      C.particleById = indexBy(C.particles, 'id');
      C.presets = got.particles.presets || {};
    }
    if (got.recipes) {
      C.recipes = rowsToObjects(got.recipes.fields, got.recipes.rows);
    }
    if (got.circuits) {
      C.circuits = rowsToObjects(got.circuits.fields, got.circuits.rows);
      C.rules = got.circuits.rules || {};
      C.circuitByBlock = indexBy(C.circuits, 'id');
      for (const c of C.circuits) {
        if (!C.circuitByRole.has(c.role)) C.circuitByRole.set(c.role, []);
        C.circuitByRole.get(c.role).push(c);
      }
    }
    if (got.models) C.models = got.models.models || {};
    if (got.mobtex) C.mobTex = got.mobtex.models || {};

  // 物品 ID = 原版方块 ID，blocks.json 里 b.orig 就是它。
  // BLOCKS 是 blocks.js 异步填充的，所以 main.js 读完图集后要再调一次 reindexBlocks()
  C.reindexBlocks = function reindexBlocks() {
    const blocks = window.BLOCKS || [];
    if (!blocks.length || !C.itemById.size) return 0;
    C.blockToItem.clear();
    C.itemToBlock.clear();
    for (const b of blocks) {
      if (b.orig == null) continue;
      const item = C.itemById.get(b.orig);
      if (item) {
        C.itemToBlock.set(item.id, b.id);
        C.blockToItem.set(b.id, item.id);
      } else {
        C.blockToItem.set(b.id, b.orig);
      }
    }
    return C.blockToItem.size;
  };

  C.reindexBlocks();

  C.counts = {
      items: C.items.length, mobs: C.mobs.length, particles: C.particles.length,
      recipes: C.recipes.length, circuits: C.circuits.length,
      models: Object.keys(C.models).length,
    };
    C.loaded = true;
    console.log('[内容层]', JSON.stringify(C.counts), C.errors.length ? '错误 ' + C.errors.join('; ') : '');
    return C;
  }

  Object.assign(C, { iconURL, particleTexURL, mobTexURL, search });
  window.Content = C;
  C.ready = load();
})();
