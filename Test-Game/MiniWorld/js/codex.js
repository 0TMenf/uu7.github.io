/**
 * 原版内容图鉴：物品 / 合成 / 生物 / 粒子 / 电路
 * ---------------------------------------------------------------
 * 五个系统共用一个全屏面板。数据来自 Content，动作通过 init 注入的回调
 * 交回主程序（给物品、合成、生成生物、播放特效、放演示电路）。
 * 面板 DOM 由本文件生成，index.html 只需要一个空 #codex 容器。
 */
(function () {
  'use strict';

  const TABS = [
    { key: 'items', label: '物品', icon: '▣', hint: '原版 3877 件道具与方块' },
    { key: 'recipes', label: '合成', icon: '⊞', hint: '原版配方，按 3×3 摆位' },
    { key: 'mobs', label: '生物', icon: '✦', hint: '原版 298 种生物' },
    { key: 'particles', label: '粒子', icon: '✧', hint: '原版 634 个特效' },
    { key: 'circuits', label: '电路', icon: '⚡', hint: '电石元件与信号网络' },
  ];

  const PARTICLE_TYPE = { 1: '烟雾', 2: '爆炸', 3: '光效', 4: '粒子', 5: '火焰', 6: '环境', 7: '提示' };
  const MOB_TYPE = { 0: '怪物', 1: '动物', 2: '稀有', 3: '水生物', 4: '坐骑', 5: '村民', 6: 'BOSS', 7: 'NPC', 8: '飞行', 9: '球' };
  const ROLE_CN = {
    source: '电源', wire: '导线', switch: '开关', button: '按钮', pressure: '感压板',
    repeater: '增幅器', comparator: '比较器', lamp: '信号灯', piston: '机械臂',
    sensor: '触碰', emitter: '发射器', funnel: '漏斗', spring: '弹簧', logic: '运算',
  };
  const CIRCUIT_COLOR = {
    source: '#E8A13A', wire: '#C96A4A', switch: '#7E9A55', button: '#9A7B55',
    pressure: '#8C9A7A', repeater: '#5C8FB0', comparator: '#7A72A8', lamp: '#D8B84A',
    piston: '#9A8A6A', sensor: '#6FA39A', emitter: '#B06A6A', funnel: '#8A8A8A',
    spring: '#A08A5A', logic: '#6A8AB0',
  };

  const PAGE = 96;

  const X = {
    root: null,
    ready: false,
    open: false,
    tab: 'items',
    state: {},
    selected: null,
    hooks: {},
    atlasURL: null,
    painting: false,
    els: {},
  };

  TABS.forEach((t) => { X.state[t.key] = { q: '', page: 0, cat: '' }; });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------- 面板骨架

  function buildDOM() {
    X.root.innerHTML =
      '<div class="cx-panel">'
      + '<div class="cx-head">'
      + '  <div class="cx-title"><b>原版图鉴</b><span id="cxSub">数据来自 0.44.2 客户端</span></div>'
      + '  <div class="cx-search">'
      + '    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m15.4 15.4 4.2 4.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'
      + '    <input id="cxSearch" type="text" placeholder="搜索名称 / 英文名 / ID" autocomplete="off" spellcheck="false" />'
      + '    <button id="cxClear" class="cx-clear hidden" title="清空">×</button>'
      + '  </div>'
      + '  <button id="cxClose" class="cx-close" title="关闭（Esc）">×</button>'
      + '</div>'
      + '<div class="cx-body">'
      + '  <aside id="cxTabs" class="cx-tabs"></aside>'
      + '  <div class="cx-main">'
      + '    <div id="cxCats" class="cx-cats"></div>'
      + '    <div id="cxGrid" class="cx-grid"></div>'
      + '    <div id="cxEmpty" class="cx-empty hidden">没有找到匹配的内容</div>'
      + '  </div>'
      + '  <aside class="cx-side"><div id="cxDetail" class="cx-detail"></div></aside>'
      + '</div>'
      + '<div class="cx-foot">'
      + '  <span id="cxCount" class="cx-count">—</span>'
      + '  <div class="cx-pager">'
      + '    <button id="cxPrev" class="cx-page">‹ 上一页</button>'
      + '    <span id="cxPage">1 / 1</span>'
      + '    <button id="cxNext" class="cx-page">下一页 ›</button>'
      + '  </div>'
      + '  <span id="cxHint" class="cx-hint">按 C 打开 · Esc 关闭</span>'
      + '</div>'
      + '</div>';

    X.els = {
      sub: document.getElementById('cxSub'),
      tabs: document.getElementById('cxTabs'),
      cats: document.getElementById('cxCats'),
      grid: document.getElementById('cxGrid'),
      empty: document.getElementById('cxEmpty'),
      detail: document.getElementById('cxDetail'),
      search: document.getElementById('cxSearch'),
      clear: document.getElementById('cxClear'),
      count: document.getElementById('cxCount'),
      page: document.getElementById('cxPage'),
      prev: document.getElementById('cxPrev'),
      next: document.getElementById('cxNext'),
      hint: document.getElementById('cxHint'),
    };
  }

  // ---------------------------------------------------------------- 图标

  function ensureAtlas() {
    if (X.atlasURL) return Promise.resolve(X.atlasURL);
    if (!X.hooks.atlasCanvas) return Promise.resolve('');
    if (X.painting) return Promise.resolve('');
    X.painting = true;
    return new Promise((res) => {
      X.hooks.atlasCanvas.toBlob((b) => {
        X.atlasURL = b ? URL.createObjectURL(b) : '';
        X.painting = false;
        res(X.atlasURL);
      }, 'image/png');
    });
  }

  function paintTile(el, blockId, size) {
    if (!X.atlasURL || !blockId || !window.TILE_TOP) return false;
    const GRID = window.ATLAS_GRID, CELL = window.ATLAS_CELL, PAD = window.ATLAS_PAD;
    const AS = window.ATLAS_SIZE, TILE = window.TILE;
    const tile = window.TILE_TOP[blockId] | 0;
    const gx = tile % GRID, gy = (tile / GRID) | 0;
    const S = GRID * size, k = S / AS, off = (size - TILE * k) / 2;
    el.style.backgroundImage = 'url(' + X.atlasURL + ')';
    el.style.backgroundSize = S + 'px ' + S + 'px';
    el.style.backgroundPosition =
      (-(gx * CELL + PAD) * k + off) + 'px ' + (-(gy * CELL + PAD) * k + off) + 'px';
    return true;
  }

  /** 给一个 .cx-ico 元素画图标，返回是否用了图片 */
  function paintIcon(el, kind, row, size) {
    const C = window.Content;
    el.classList.remove('letter');
    el.textContent = '';
    el.style.backgroundImage = '';
    el.style.backgroundColor = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    let url = '';

    if (kind === 'items') url = C.iconURL(row);
    else if (kind === 'recipes') {
      const it = C.itemById.get(row.result);
      url = it ? C.iconURL(it) : '';
    } else if (kind === 'particles' && row.textures && row.textures.length) {
      url = C.particleTexURL(row.textures[0]);
    } else if (kind === 'mobs' && row.model && C.mobTex[row.model] && C.mobTex[row.model].length) {
      const f = C.mobTex[row.model].find((n) => !/_emi|alpha|touming/i.test(n)) || C.mobTex[row.model][0];
      url = C.mobTexURL(row.model, f);
    }

    if (url) {
      el.style.backgroundImage = 'url(' + url + ')';
      el.style.backgroundSize = 'contain';
      el.style.backgroundPosition = 'center';
      return true;
    }

    // 方块类回退到图集裁切
    const block = kind === 'items' ? row.block
      : kind === 'recipes' ? (C.itemToBlock.get(row.result) || 0)
        : kind === 'circuits' ? row.id : 0;
    if (block && paintTile(el, block, size)) return true;

    // 最后用色块 + 首字
    const color = kind === 'circuits' ? (CIRCUIT_COLOR[row.role] || '#8C9A7A')
      : kind === 'mobs' ? '#7E9A6B'
        : kind === 'particles' ? (C.presets[row.type] || {}).color || '#D8B84A'
          : '#A8B39A';
    el.style.backgroundColor = color;
    el.classList.add('letter');
    el.textContent = (row.name || '?').slice(0, 1);
    return false;
  }

  // ---------------------------------------------------------------- 数据

  function pool() {
    const C = window.Content;
    switch (X.tab) {
      case 'items': return C.items;
      case 'recipes': return C.recipes;
      case 'mobs': return C.mobs;
      case 'particles': return C.particles;
      case 'circuits': return C.circuits;
      default: return [];
    }
  }

  function catOf(row) {
    switch (X.tab) {
      case 'items': return 'type:' + row.type;
      case 'recipes': return 'type:' + row.cat;
      case 'mobs': return 'type:' + row.type;
      case 'particles': return 'type:' + row.type;
      case 'circuits': return 'role:' + row.role;
      default: return '';
    }
  }

  function catLabel(v) {
    const [k, n] = v.split(':');
    if (k === 'role') return ROLE_CN[n] || n;
    if (X.tab === 'particles') return PARTICLE_TYPE[n] || ('分类 ' + n);
    if (X.tab === 'mobs') return MOB_TYPE[n] || ('类型 ' + n);
    if (X.tab === 'recipes') return ['常用', '装备', '建筑', '机械', '配方'][+n] || ('类别 ' + n);
    return '类别 ' + n;
  }

  function matchQ(row, q) {
    if (!q) return true;
    const s = (row.name || '').toLowerCase();
    const en = (row.en || '').toLowerCase();
    const id = String(row.id != null ? row.id : '');
    return s.includes(q) || en.includes(q) || id.includes(q);
  }

  function filtered() {
    const st = X.state[X.tab];
    const q = st.q.trim().toLowerCase();
    const all = pool();
    return all.filter((r) => (!st.cat || catOf(r) === st.cat) && matchQ(r, q));
  }

  function nameOf(row) {
    if (X.tab === 'recipes') return row.name || ('配方 ' + row.id);
    return row.name || ('#' + row.id);
  }

  function subOf(row) {
    switch (X.tab) {
      case 'items': return row.block ? '方块 #' + row.block : (row.en || ('#' + row.id));
      case 'recipes': return '#' + row.result + ' ×' + row.count;
      case 'mobs': return MOB_TYPE[row.type] || ('#' + row.id);
      case 'particles': return PARTICLE_TYPE[row.type] || ('#' + row.id);
      case 'circuits': return ROLE_CN[row.role] || row.role;
      default: return '';
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderTabs() {
    const C = window.Content;
    const counts = {
      items: C.items.length, recipes: C.recipes.length, mobs: C.mobs.length,
      particles: C.particles.length, circuits: C.circuits.length,
    };
    const frag = document.createDocumentFragment();
    TABS.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'cx-tab' + (t.key === X.tab ? ' on' : '');
      b.dataset.k = t.key;
      b.innerHTML = '<i>' + t.icon + '</i><b>' + t.label + '</b><em>' + counts[t.key] + '</em>';
      b.title = t.hint;
      frag.appendChild(b);
    });
    X.els.tabs.innerHTML = '';
    X.els.tabs.appendChild(frag);
  }

  function renderCats() {
    const counts = new Map();
    pool().forEach((r) => {
      const c = catOf(r);
      counts.set(c, (counts.get(c) || 0) + 1);
    });
    const st = X.state[X.tab];
    const frag = document.createDocumentFragment();
    const mk = (v, label, n) => {
      const b = document.createElement('button');
      b.className = 'cx-chip' + (v === st.cat ? ' on' : '');
      b.dataset.v = v;
      b.textContent = label + ' ' + n;
      frag.appendChild(b);
    };
    mk('', '全部', pool().length);
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .forEach(([v, n]) => mk(v, catLabel(v), n));
    X.els.cats.innerHTML = '';
    X.els.cats.appendChild(frag);
  }

  function renderGrid() {
    const rows = filtered();
    const st = X.state[X.tab];
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (st.page >= pages) st.page = pages - 1;
    const from = st.page * PAGE;
    const slice = rows.slice(from, from + PAGE);

    const frag = document.createDocumentFragment();
    slice.forEach((row) => {
      const b = document.createElement('button');
      b.className = 'cx-cell' + (X.selected === row ? ' on' : '');
      const ic = document.createElement('i');
      ic.className = 'cx-ico';
      paintIcon(ic, X.tab, row, 44);
      const nm = document.createElement('b');
      nm.textContent = nameOf(row);
      const sb = document.createElement('em');
      sb.textContent = subOf(row);
      b.append(ic, nm, sb);
      b.dataset.id = String(row.id != null ? row.id : '');
      frag.appendChild(b);
    });

    X.els.grid.innerHTML = '';
    X.els.grid.appendChild(frag);
    X.els.empty.classList.toggle('hidden', slice.length > 0);
    X.els.count.textContent = rows.length + ' 条 · 第 ' + (st.page + 1) + '/' + pages + ' 页';
    X.els.page.textContent = (st.page + 1) + ' / ' + pages;
    X.els.prev.disabled = st.page <= 0;
    X.els.next.disabled = st.page >= pages - 1;

    // 选中项不在当前页就清掉详情
    if (X.selected && slice.indexOf(X.selected) < 0) X.selected = null;
    renderDetail();
  }

  function rowByEvent(e) {
    const el = e.target.closest('.cx-cell');
    if (!el) return null;
    const rows = filtered();
    const st = X.state[X.tab];
    const idx = [...X.els.grid.children].indexOf(el) + st.page * PAGE;
    return rows[idx] || null;
  }

  function renderDetail() {
    const row = X.selected;
    if (!row) {
      X.els.detail.innerHTML = '<div class="cx-idle"><span>?</span><p>点一个条目<br>看它的原版数据</p></div>';
      return;
    }
    const C = window.Content;
    const big = '<div class="cx-big"><i></i></div>';
    const name = esc(nameOf(row));
    const en = esc(row.en || (X.tab === 'recipes' ? 'Recipe #' + row.id : 'ID ' + row.id));

    let tags = '', attrs = '', extra = '', action = '';

    if (X.tab === 'items') {
      tags = tag(row.block ? '可放置方块' : '道具', true) + tag('品质 ' + (row.quality || 0));
      attrs = kv('物品 ID', row.id) + kv('对应方块', row.block || '—')
        + kv('最大堆叠', row.stack || 64) + kv('英文名', row.en || '—');
      extra = '<p class="cx-desc">' + esc(row.desc || '原版物品，暂无描述。') + '</p>';
      action = btn('加入背包', 'give');
    } else if (X.tab === 'recipes') {
      const it = C.itemById.get(row.result);
      tags = tag('产出 ×' + row.count, true) + tag(catLabel('type:' + row.cat));
      const pat = window.Inventory ? window.Inventory.pattern(row) : new Array(9).fill(0);
      let grid = '<div class="cx-craft">';
      for (let i = 0; i < 9; i++) {
        const id = pat[i];
        const m = C.itemById.get(id);
        grid += '<div class="cx-craft-cell' + (id ? ' has' : '') + '" title="'
          + esc(m ? m.name : '') + '">' + esc(m ? m.name.slice(0, 2) : '') + '</div>';
      }
      grid += '</div>';
      attrs = kv('配方 ID', row.id) + kv('产出 ID', row.result)
        + kv('摆放', row.gridX + '×' + row.gridY) + kv('材料种类', row.mats.length);
      extra = grid + '<p class="cx-desc">材料：' + esc(row.mats.map(([id, n]) => {
        const m = C.itemById.get(id);
        return (m ? m.name : id) + '×' + n;
      }).join('、')) + '</p>';
      action = btn('合成这个', 'craft');
    } else if (X.tab === 'mobs') {
      tags = tag(MOB_TYPE[row.type] || '生物', true) + tag(row.hostile ? '主动攻击' : '被动');
      attrs = kv('生物 ID', row.id) + kv('生命', row.hp)
        + kv('攻击', row.atk) + kv('速度', (row.speed || 1).toFixed(2))
        + kv('体型', row.width + ' × ' + row.height);
      extra = '<p class="cx-desc">' + esc(row.desc || '模型目录 ' + (row.model || '无')) + '</p>';
      action = btn('在眼前生成', 'mob');
    } else if (X.tab === 'particles') {
      const pre = C.presets[row.type] || {};
      tags = tag(PARTICLE_TYPE[row.type] || '特效', true)
        + tag(['', '循环', '单次', '停留'][row.mode] || '特效');
      attrs = kv('特效 ID', row.id) + kv('发射器', row.emitters)
        + kv('源文件', (row.effect || '—') + '.' + (row.kind || ''))
        + kv('贴图', row.textures && row.textures.length ? row.textures.length + ' 张' : '程序生成');
      extra = '<div class="cx-swatch" style="background:' + esc(pre.color || '#fff') + '"></div>'
        + '<p class="cx-desc">按原版分类还原的运动预设，贴图来自客户端 particles/texture。</p>';
      action = btn('播放特效', 'particle');
    } else if (X.tab === 'circuits') {
      const n = window.Redstone && window.Redstone.nodes.get(row.id + ',0,0');
      tags = tag(ROLE_CN[row.role] || row.role, true) + tag('方块 #' + row.id);
      attrs = kv('方块 ID', row.id) + kv('角色', ROLE_CN[row.role] || row.role)
        + kv('类别', row.cat) + kv('最大信号', (C.rules.maxSignal || 15));
      const st = window.Redstone ? window.Redstone.stats : null;
      extra = '<p class="cx-desc">当前网络：' + (st ? st.nodes + ' 个节点 / ' + st.powered + ' 个带电 / ' + st.lampsOn + ' 盏灯亮' : '未进入世界') + '</p>';
      action = btn('放置演示电路', 'circuit');
    }

    X.els.detail.innerHTML = '<div class="cx-card">' + big
      + '<div class="cx-dname">' + name + '</div>'
      + '<div class="cx-den">' + en + '</div>'
      + '<div class="cx-dtags">' + tags + '</div>'
      + '<dl class="cx-rows">' + attrs + '</dl>'
      + extra + action + '</div>';

    const ic = X.els.detail.querySelector('.cx-big i');
    paintIcon(ic, X.tab, row, 96);
    const b = X.els.detail.querySelector('.cx-act');
    if (b) b.onclick = () => doAction(b.dataset.act, row);
  }

  function tag(s, main) { return '<span class="cx-tag' + (main ? ' main' : '') + '">' + esc(s) + '</span>'; }
  function kv(k, v) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>'; }
  function btn(label, act) { return '<button class="cx-act" data-act="' + act + '">' + esc(label) + '</button>'; }

  function doAction(act, row) {
    const h = X.hooks;
    let msg = '';
    switch (act) {
      case 'give': {
        const r = h.onGive ? h.onGive(row.id, 1) : null;
        msg = r ? '已加入背包：' + r.name : '背包不可用';
        break;
      }
      case 'craft': {
        const r = h.onCraft ? h.onCraft(row) : { ok: false, msg: '合成不可用' };
        msg = r.msg;
        break;
      }
      case 'mob': {
        const n = h.onSpawnMob ? h.onSpawnMob(row.id) : 0;
        msg = n ? '已生成：' + row.name : '生成失败（需要先进入世界）';
        break;
      }
      case 'particle': {
        const n = h.onPlayParticle ? h.onPlayParticle(row.id) : 0;
        msg = n ? '播放特效：' + row.name + '（' + n + ' 个粒子）' : '播放失败';
        break;
      }
      case 'circuit': {
        const n = h.onDemoCircuit ? h.onDemoCircuit() : 0;
        msg = n ? '已放置 ' + n + ' 个电路元件，灯已通电' : '放置失败（需要先进入世界）';
        break;
      }
      default: msg = '未知操作';
    }
    X.els.hint.textContent = msg;
    X.els.hint.classList.add('flash');
    setTimeout(() => X.els.hint.classList.remove('flash'), 1400);
    if (h.onToast) h.onToast(msg);
  }

  // ---------------------------------------------------------------- 生命周期

  function init(hooks) {
    X.hooks = hooks || {};
    X.root = document.getElementById('codex');
    if (!X.root) return X;
    buildDOM();

    X.els.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.cx-tab');
      if (!b) return;
      X.tab = b.dataset.k;
      X.selected = null;
      X.state[X.tab].page = 0;
      X.els.search.value = X.state[X.tab].q;
      X.els.clear.classList.toggle('hidden', !X.state[X.tab].q);
      renderTabs(); renderCats(); renderGrid();
    });

    X.els.cats.addEventListener('click', (e) => {
      const b = e.target.closest('.cx-chip');
      if (!b) return;
      X.state[X.tab].cat = b.dataset.v;
      X.state[X.tab].page = 0;
      X.selected = null;
      renderCats(); renderGrid();
    });

    X.els.grid.addEventListener('click', (e) => {
      const row = rowByEvent(e);
      if (!row) return;
      X.selected = row;
      X.els.grid.querySelectorAll('.cx-cell.on').forEach((n) => n.classList.remove('on'));
      const cell = e.target.closest('.cx-cell');
      if (cell) cell.classList.add('on');
      renderDetail();
      if (X.hooks.onSelect) X.hooks.onSelect(X.tab, row);
    });

    let t = null;
    X.els.search.addEventListener('input', () => {
      X.state[X.tab].q = X.els.search.value;
      X.els.clear.classList.toggle('hidden', !X.state[X.tab].q);
      clearTimeout(t);
      t = setTimeout(() => { X.state[X.tab].page = 0; renderGrid(); }, 120);
    });
    X.els.clear.onclick = () => {
      X.els.search.value = '';
      X.state[X.tab].q = '';
      X.els.clear.classList.add('hidden');
      X.state[X.tab].page = 0;
      renderGrid();
      X.els.search.focus();
    };

    X.els.prev.onclick = () => { X.state[X.tab].page--; renderGrid(); X.els.grid.parentElement.scrollTop = 0; };
    X.els.next.onclick = () => { X.state[X.tab].page++; renderGrid(); X.els.grid.parentElement.scrollTop = 0; };

    document.getElementById('cxClose').onclick = () => close();
    X.root.addEventListener('mousedown', (e) => { if (e.target === X.root) close(); });

    X.ready = true;
    return X;
  }

  async function show() {
    if (!X.ready) return;
    const C = window.Content;
    if (!C || !C.loaded) {
      try { await C.ready; } catch (e) { /* 数据缺失也要能打开，只是空列表 */ }
    }
    X.open = true;
    X.root.classList.remove('hidden');
    document.body.classList.add('codex-open');
    X.els.sub.textContent = '物品 ' + C.items.length + ' · 配方 ' + C.recipes.length
      + ' · 生物 ' + C.mobs.length + ' · 粒子 ' + C.particles.length
      + ' · 电路 ' + C.circuits.length;
    renderTabs(); renderCats(); renderGrid();
    ensureAtlas().then(() => { if (X.open) renderGrid(); });
    setTimeout(() => { try { X.els.search.focus(); } catch (e) { /* noop */ } }, 30);
  }

  function close() {
    if (!X.open) return;
    X.open = false;
    X.root.classList.add('hidden');
    document.body.classList.remove('codex-open');
  }

  function isOpen() { return X.open; }

  window.Codex = {
    init, open: show, close, isOpen,
    get tab() { return X.tab; },
    get selected() { return X.selected; },
  };
})();
