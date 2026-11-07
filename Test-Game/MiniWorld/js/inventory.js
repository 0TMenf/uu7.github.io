/**
 * 物品 / 背包
 * ---------------------------------------------------------------
 * 3877 个原版物品 + 595 个配方。9 格快捷栏从「只能拿方块」升级成真实物品槽：
 * 每格记录 { item, block, count }，生存模式有数量、会消耗，创造模式无限。
 *
 * 兼容层：window.PLACEABLE 仍是「9 个方块 ID 的数组」，现有 hotbar / Bag / 滚轮
 * 逻辑一行都不用改；这里只是接管它的写入。
 */
(function () {
  'use strict';

  const INV = {
    ready: false,
    mode: 'creative',        // creative | survival
    slots: [],
    activeIndex: 0,
    onChange: null,
    store: {},               // itemId → 总数量（生存模式的仓库）
    KEY: 'miniworld_inventory_v1',
  };

  const EMPTY = () => ({ item: 0, block: 0, count: 0 });

  function content() { return window.Content; }

  function defaultBlocks() {
    return (window.PLACEABLE || [1, 2, 3, 4, 5, 6, 7, 8, 12]).slice(0, 9);
  }

  function init(opts) {
    opts = opts || {};
    INV.onChange = opts.onChange || null;
    INV.mode = opts.mode || 'creative';

    const blocks = defaultBlocks();
    INV.slots = [];
    for (let i = 0; i < 9; i++) {
      const b = blocks[i] || 0;
      INV.slots.push({
        item: content() ? (content().blockToItem.get(b) || b) : b,
        block: b,
        count: INV.mode === 'creative' ? -1 : 64,
      });
    }
    // 接管 PLACEABLE：保持同一个数组引用，别让 main.js 里的闭包失效
    const arr = INV.slots.map((s) => s.block);
    if (window.PLACEABLE && window.PLACEABLE.length === 9) {
      for (let i = 0; i < 9; i++) window.PLACEABLE[i] = arr[i];
      INV.PLACEABLE = window.PLACEABLE;
    } else {
      INV.PLACEABLE = arr;
      window.PLACEABLE = arr;
    }

    try {
      const raw = localStorage.getItem(INV.KEY);
      if (raw) {
        const d = JSON.parse(raw);
        INV.store = d.store || {};
        if (d.slots && d.slots.length === 9) {
          for (let i = 0; i < 9; i++) {
            INV.slots[i].item = d.slots[i].item || INV.slots[i].item;
            INV.slots[i].block = d.slots[i].block || INV.slots[i].block;
            INV.slots[i].count = d.slots[i].count != null ? d.slots[i].count : INV.slots[i].count;
            INV.PLACEABLE[i] = INV.slots[i].block;
          }
        }
      }
    } catch (e) { /* localStorage 不可用就算了 */ }

    INV.ready = true;
    save();
    return INV;
  }

  function save() {
    try {
      localStorage.setItem(INV.KEY, JSON.stringify({
        store: INV.store,
        slots: INV.slots.map((s) => ({ item: s.item, block: s.block, count: s.count })),
      }));
    } catch (e) { /* noop */ }
  }

  function setMode(mode) {
    INV.mode = mode === 'survival' ? 'survival' : 'creative';
    if (INV.mode === 'creative') {
      for (const s of INV.slots) if (s.block) s.count = -1;
    } else {
      for (const s of INV.slots) if (s.count === -1) s.count = 64;
    }
    save();
    emit();
  }

  function emit() { if (INV.onChange) INV.onChange(INV); }

  /** 兼容 Bag：返回 9 个方块 ID 数组 */
  function getSlots() { return INV.PLACEABLE; }

  function getActive() { return INV.activeIndex; }

  function setSlot(i, blockId) {
    if (i < 0 || i >= 9) return;
    const item = content() ? (content().blockToItem.get(blockId) || blockId) : blockId;
    INV.slots[i] = { item, block: blockId, count: INV.mode === 'creative' ? -1 : 64 };
    INV.PLACEABLE[i] = blockId;
    INV.activeIndex = i;
    save();
    emit();
  }

  function select(i) {
    if (i < 0 || i >= 9) return;
    INV.activeIndex = i;
    emit();
  }

  function active() { return INV.slots[INV.activeIndex] || EMPTY(); }
  function activeBlock() { return active().block; }

  /** 生存模式放置后消耗一个；创造模式永远不消耗 */
  function consumeActive() {
    if (INV.mode !== 'survival') return true;
    const s = active();
    if (!s.block) return false;
    if (s.count <= 0) return false;
    s.count--;
    if (s.count === 0) {
      INV.slots[INV.activeIndex] = EMPTY();
      INV.PLACEABLE[INV.activeIndex] = 0;
    }
    save();
    emit();
    return true;
  }

  function add(itemId, n) {
    n = n || 1;
    const item = content() && content().itemById.get(+itemId);
    const block = content() ? (content().itemToBlock.get(+itemId) || 0) : 0;
    // 先找同物品槽叠加；创造模式本来就是无限，直接选中那一格即可
    for (let i = 0; i < 9; i++) {
      const s = INV.slots[i];
      if (s.item !== +itemId) continue;
      if (INV.mode === 'creative') {
        INV.activeIndex = i;
        save(); emit();
        return i;
      }
      if (s.count >= 0) {
        s.count += n;
        save(); emit();
        return i;
      }
    }
    // 再找空槽
    for (let i = 0; i < 9; i++) {
      if (!INV.slots[i].block) {
        INV.slots[i] = {
          item: +itemId, block,
          count: INV.mode === 'creative' ? -1 : n,
        };
        INV.PLACEABLE[i] = block;
        INV.activeIndex = i;
        save(); emit();
        return i;
      }
    }
    // 满仓：放仓库
    INV.store[+itemId] = (INV.store[+itemId] || 0) + n;
    save(); emit();
    return -1;
  }

  /** 从图鉴加入物品；物品若对应方块就同时进快捷栏 */
  function give(itemId, n) {
    const slot = add(itemId, n || 1);
    return { slot, item: itemId, name: (content() && content().itemById.get(+itemId) || {}).name || ('物品 ' + itemId) };
  }

  function count(itemId) {
    let c = INV.store[+itemId] || 0;
    for (const s of INV.slots) {
      if (s.item === +itemId && s.count > 0) c += s.count;
    }
    return c;
  }

  function remove(itemId, n) {
    if (INV.mode === 'creative') return true;
    n = n || 1;
    if (count(itemId) < n) return false;
    for (const s of INV.slots) {
      if (s.item !== +itemId || s.count <= 0) continue;
      const take = Math.min(n, s.count);
      s.count -= take; n -= take;
      if (!s.count) {
        const i = INV.slots.indexOf(s);
        INV.slots[i] = EMPTY();
        INV.PLACEABLE[i] = 0;
      }
      if (!n) break;
    }
    if (n > 0) {
      INV.store[+itemId] = Math.max(0, (INV.store[+itemId] || 0) - n);
    }
    save(); emit();
    return true;
  }

  /** 合成：创造模式直接产出；生存模式先扣材料 */
  function craft(recipe) {
    if (!recipe) return { ok: false, msg: '没有这个配方' };
    if (INV.mode === 'survival') {
      const need = new Map();
      for (const [id, n] of recipe.mats) need.set(id, (need.get(id) || 0) + n);
      for (const [id, n] of need) {
        if (count(id) < n) return { ok: false, msg: '材料不够' };
      }
      for (const [id, n] of need) remove(id, n);
    }
    add(recipe.result, recipe.count || 1);
    const name = recipe.name || ((content() && content().itemById.get(recipe.result) || {}).name);
    return { ok: true, msg: '合成 ' + name + ' ×' + (recipe.count || 1) };
  }

  /** 找到某个配方的 3×3 图案（用于图鉴展示） */
  function pattern(recipe) {
    const g = new Array(9).fill(0);
    const w = Math.min(3, Math.max(1, recipe.gridX || 3));
    const h = Math.min(3, Math.max(1, recipe.gridY || 3));
    let k = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (k < recipe.mats.length) g[y * 3 + x] = recipe.mats[k++][0];
      }
    }
    return g;
  }

  function summary() {
    return INV.slots.map((s, i) => ({
      i: i + 1, item: s.item, block: s.block, count: s.count,
      name: (content() && content().itemById.get(s.item) || {}).name || '',
    }));
  }

  window.Inventory = Object.assign(INV, {
    init, setMode, getSlots, getActive, setSlot, select, active, activeBlock,
    consumeActive, add, give, count, remove, craft, pattern, summary, save,
  });
})();
