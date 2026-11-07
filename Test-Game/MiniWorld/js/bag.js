/**
 * 背包（全屏物品栏）
 * ---------------------------------------------------------------
 * 只做界面与交互，不改世界数据。主程序通过 init() 注入图集和回调：
 *   Bag.init({ atlasCanvas, getSlots, getActive, onChange })
 *   Bag.open(slotIndex) / Bag.close() / Bag.isOpen() / Bag.sync()
 *
 * 图标不逐张生成 dataURL（582 个方块会很慢），统一拿图集 blob URL + background-position 裁切。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- 分组

  // 原版有 130 个类别，直接铺出来没法用。这里收成 6 组。
  const GROUPS = [
    { key: 'all', label: '全部', hint: '所有可放置方块' },
    { key: 'build', label: '建筑', hint: '墙、地面、门窗' },
    { key: 'nature', label: '自然', hint: '草、树、花与野生植物' },
    { key: 'deco', label: '装饰', hint: '家具、摆件、灯具' },
    { key: 'store', label: '容器', hint: '箱子、熔炉、工作台' },
    { key: 'mech', label: '机械', hint: '电路、活塞、载具零件' },
    { key: 'other', label: '其他', hint: '不好归类的零碎' },
  ];

  const GROUP_OF = {
    build: ['basic', 'glass', 'glasspane', 'slab', 'stair', 'fence', 'fencegate', 'wall',
      'windows', 'door', 'trapdoor', 'brick', 'giantstone', 'airwall', 'blueprint',
      'buildblueprint', 'sand', 'dirt', 'gravel', 'farmland', 'buryland', 'cosmicburyland',
      'pollution', 'fullycustomblock', 'custombasic', 'stonecore'],

    nature: ['grass', 'log', 'mutantlog', 'grayleaf', 'starmushroom', 'mutantmushroom',
      'hiveempty', 'hivefull', 'aliencloud', 'cactus', 'bamboo', 'lilypad', 'watermelon',
      'herb', 'colorherbs', 'plant', 'flowergrow', 'breakable', 'totem', 'gianttotem',
      'giantbattletotem', 'alientotem', 'crystalemitter', 'rockoil', 'chrismastree',
      'stillfluid', 'flowfluid'],

    deco: ['carpet', 'deco', 'flowerpot', 'jar', 'jarex', 'furniture', 'chair', 'shafa',
      'bed', 'bookcase', 'photoframe', 'cake', 'candle', 'chrismasbox', 'musicnote',
      'musictone', 'musicloop', 'musicuncoil', 'dragoncup', 'dragonegg', 'teamprepoint',
      'goalblock', 'teamspawn', 'lamp', 'light', 'elight', 'painting'],

    store: ['chest', 'simplechest', 'lockchest', 'initchest', 'chest_password', 'furnace',
      'crafting', 'anvil', 'enchanting', 'bookeditortable', 'bookcabinet'],

    mech: ['machine', 'mechamarker', 'mechaslider', 'mecharotate', 'rangepiston', 'piston',
      'pistonexten', 'sensorblock', 'repeater', 'comparator', 'powerbasic', 'arithmatic',
      'emitter', 'funnel', 'spring', 'workshop', 'modelcraft', 'replicator',
      'regionreplicator', 'transfercore', 'screen', 'propeller', 'wing', 'wheel',
      'empennage', 'spacepropeller', 'fuel_tank', 'catapult', 'bomb', 'bangalore',
      'firework', 'mobspawner', 'selectbobspawner', 'actormodel', 'modeleditor'],
  };

  const CAT_CN = {
    basic: '基础', glass: '玻璃', glasspane: '玻璃板', slab: '台阶', stair: '楼梯',
    wall: '墙', windows: '窗户', door: '门', trapdoor: '活板门', fence: '栅栏',
    fencegate: '栅栏门', brick: '砖石', giantstone: '巨石', airwall: '空气墙',
    blueprint: '蓝图', buildblueprint: '建筑蓝图', sand: '沙土', dirt: '泥土',
    gravel: '砂砾', farmland: '耕地', buryland: '埋藏地', cosmicburyland: '星岩地',
    pollution: '污染地', glassbottle: '玻璃瓶', log: '原木', mutantlog: '变异木',
    grayleaf: '灰叶', starmushroom: '星光蘑菇', mutantmushroom: '变异蘑菇',
    hiveempty: '空蜂巢', hivefull: '蜂巢', aliencloud: '异星云', cactus: '仙人掌',
    bamboo: '竹子', lilypad: '荷叶', watermelon: '西瓜', herb: '草', colorherbs: '彩草',
    plant: '植物', flowergrow: '花卉', breakable: '可破坏物', totem: '图腾',
    gianttotem: '巨图腾', giantbattletotem: '战斗图腾', alientotem: '异星图腾',
    crystalemitter: '水晶发射器', rockoil: '油矿', chrismastree: '圣诞树',
    carpet: '地毯', deco: '装饰', flowerpot: '花盆', jar: '罐子', jarex: '大罐子',
    furniture: '家具', chair: '椅子', shafa: '沙发', bed: '床', bookcase: '书架',
    photoframe: '相框', cake: '蛋糕', candle: '蜡烛', chrismasbox: '圣诞礼盒',
    musicnote: '音符', musictone: '音调', musicloop: '循环音乐', musicuncoil: '音乐线圈',
    dragoncup: '龙杯', dragonegg: '龙蛋', teamprepoint: '队伍点', goalblock: '终点',
    teamspawn: '出生点', lamp: '灯', light: '光源', elight: '电灯',
    chest: '箱子', simplechest: '简易箱子', lockchest: '密码箱', initchest: '初始箱',
    chest_password: '密码箱', furnace: '熔炉', crafting: '工作台', anvil: '铁砧',
    enchanting: '附魔台', bookeditortable: '编书台', bookcabinet: '书柜',
    machine: '机械', mechamarker: '机械标记', mechaslider: '滑动件',
    mecharotate: '旋转件', rangepiston: '范围活塞', piston: '活塞',
    pistonexten: '活塞臂', sensorblock: '传感器', repeater: '中继器',
    comparator: '比较器', powerbasic: '电源', arithmatic: '运算器',
    emitter: '发射器', funnel: '漏斗', spring: '弹簧', workshop: '工坊',
    modelcraft: '模型台', replicator: '复制器', regionreplicator: '区域复制',
    transfercore: '传送核心', screen: '屏幕', propeller: '螺旋桨', wing: '机翼',
    wheel: '轮子', empennage: '尾翼', spacepropeller: '太空桨', fuel_tank: '燃料箱',
    catapult: '投石机', bomb: '炸弹', bangalore: '爆破筒', firework: '烟花',
    mobspawner: '刷怪笼', selectbobspawner: '生物点', actormodel: '角色模型',
    modeleditor: '模型编辑器', stillfluid: '静态液体', flowfluid: '流动液体',
  };

  const GROUP_CN = {};
  GROUPS.forEach((g) => { GROUP_CN[g.key] = g.label; });

  // 反查表：cat → group
  const CAT_GROUP = {};
  Object.keys(GROUP_OF).forEach((g) => {
    GROUP_OF[g].forEach((c) => { CAT_GROUP[c] = g; });
  });

  function groupOf(cat) {
    if (CAT_GROUP[cat]) return CAT_GROUP[cat];
    return 'other';
  }

  // ---------------------------------------------------------------- 状态

  let cfg = null;              // init 注入
  let atlasURL = null;         // 图集 blob URL
  let painting = false;        // 正在生成 blob URL
  let isOpen = false;
  let group = 'all';
  let query = '';
  let targetSlot = 0;          // 当前要放入的快捷栏格子
  let detailId = 0;
  let list = [];               // 当前筛出来的方块
  let els = {};

  const ICON_S = 40;           // 网格图标显示尺寸
  const DETAIL_ICON = 96;

  // ---------------------------------------------------------------- 图标

  function paint(el, id, size) {
    if (!el || !id) return;
    const GRID = window.ATLAS_GRID;
    const CELL = window.ATLAS_CELL;
    const PAD = window.ATLAS_PAD;
    const AS = window.ATLAS_SIZE;
    const TILE = window.TILE;

    const tile = window.TILE_TOP[id] | 0;
    const gx = tile % GRID;
    const gy = (tile / GRID) | 0;

    const S = GRID * size;            // 整张图集缩到多大
    const k = S / AS;                 // 缩放比
    const off = (size - TILE * k) / 2; // 把格子居中到图标框里

    el.style.backgroundImage = 'url(' + atlasURL + ')';
    el.style.backgroundSize = S + 'px ' + S + 'px';
    el.style.backgroundPosition =
      (-(gx * CELL + PAD) * k + off) + 'px ' + (-(gy * CELL + PAD) * k + off) + 'px';
  }

  function ensureAtlas() {
    if (atlasURL) return Promise.resolve(atlasURL);
    if (painting) {
      return new Promise((res) => {
        const t = setInterval(() => {
          if (atlasURL || !painting) { clearInterval(t); res(atlasURL); }
        }, 60);
      });
    }
    painting = true;
    return new Promise((res) => {
      const c = cfg.atlasCanvas;
      if (!c) { painting = false; return res(''); }
      c.toBlob((b) => {
        atlasURL = b ? URL.createObjectURL(b) : '';
        painting = false;
        res(atlasURL);
      }, 'image/png');
    });
  }

  // ---------------------------------------------------------------- 数据

  function source() {
    return window.BLOCKS || [];
  }

  function visible(b) {
    return b && (b.solid || b.liquid);
  }

  function match(b, q) {
    if (!q) return true;
    if ((b.name || '').toLowerCase().indexOf(q) >= 0) return true;
    if ((b.en || '').toLowerCase().indexOf(q) >= 0) return true;
    const cn = CAT_CN[b.cat] || '';
    if (cn.toLowerCase().indexOf(q) >= 0) return true;
    const gn = GROUP_CN[groupOf(b.cat)] || '';
    return gn.indexOf(q) >= 0;
  }

  function collect() {
    const q = query.trim().toLowerCase();
    const out = [];
    const all = source();
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (!visible(b)) continue;
      if (group !== 'all' && groupOf(b.cat) !== group) continue;
      if (!match(b, q)) continue;
      out.push(b);
    }
    return out;
  }

  // ---------------------------------------------------------------- 渲染

  function renderCats() {
    const counts = {};
    const all = source();
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (!visible(b)) continue;
      const g = groupOf(b.cat);
      counts[g] = (counts[g] || 0) + 1;
      counts.all = (counts.all || 0) + 1;
    }

    // 每组挑一个代表方块做图标
    const rep = {};
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      if (!visible(b)) continue;
      const g = groupOf(b.cat);
      if (!rep[g]) rep[g] = b.id;
    }

    const frag = document.createDocumentFragment();
    GROUPS.forEach((g) => {
      const n = counts[g.key] || 0;
      if (!n) return;
      const btn = document.createElement('button');
      btn.className = 'bag-cat' + (g.key === group ? ' on' : '');
      btn.dataset.g = g.key;
      btn.title = g.hint;

      const ic = document.createElement('i');
      ic.className = 'bag-cat-ico';
      if (g.key === 'all') ic.classList.add('all');
      else paint(ic, rep[g.key], 30);

      const tx = document.createElement('b');
      tx.textContent = g.label;

      const num = document.createElement('em');
      num.textContent = String(n);

      btn.append(ic, tx, num);
      frag.appendChild(btn);
    });

    els.cats.innerHTML = '';
    els.cats.appendChild(frag);
  }

  function renderGrid() {
    list = collect();
    const frag = document.createDocumentFragment();

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const el = document.createElement('button');
      el.className = 'bag-item';
      el.dataset.id = b.id;
      el.title = b.name + (b.en ? '　' + b.en : '');

      const ic = document.createElement('i');
      ic.className = 'bag-item-ico';
      paint(ic, b.id, ICON_S);

      const tx = document.createElement('b');
      tx.textContent = b.name || '';

      el.append(ic, tx);
      frag.appendChild(el);
    }

    els.grid.innerHTML = '';
    if (!list.length) {
      els.empty.classList.remove('hidden');
    } else {
      els.empty.classList.add('hidden');
      els.grid.appendChild(frag);
    }

    els.count.textContent = list.length + ' 个方块';
  }

  function renderHotbar() {
    const slots = cfg.getSlots();
    const active = cfg.getActive();
    const frag = document.createDocumentFragment();

    for (let i = 0; i < 9; i++) {
      const id = slots[i];
      const el = document.createElement('button');
      el.className = 'bag-slot'
        + (i === targetSlot ? ' on' : '')
        + (i === active ? ' here' : '');
      el.dataset.i = i;

      if (id) {
        const ic = document.createElement('i');
        ic.className = 'bag-slot-ico';
        paint(ic, id, 32);
        el.appendChild(ic);
        el.title = window.BLOCK_BY_ID[id] ? window.BLOCK_BY_ID[id].name : '';
      } else {
        el.classList.add('empty');
      }

      const n = document.createElement('span');
      n.textContent = String(i + 1);
      el.appendChild(n);
      frag.appendChild(el);
    }

    els.hotbar.innerHTML = '';
    els.hotbar.appendChild(frag);
  }

  function renderDetail() {
    const b = detailId ? window.BLOCK_BY_ID[detailId] : null;
    if (!b) {
      els.detail.innerHTML =
        '<div class="bd-idle">'
        + '<span class="bd-idle-ico">?</span>'
        + '<p>把鼠标移到方块上<br>看它的信息</p>'
        + '</div>';
      return;
    }

    const catCn = CAT_CN[b.cat] || b.cat || '未知';
    const grpCn = GROUP_CN[groupOf(b.cat)] || '其他';
    const hard = typeof b.hardness === 'number' && b.hardness > 0
      ? b.hardness.toFixed(1) : '瞬间';
    const geom = b.geom ? '自定义模型' : (b.cat === 'glasspane' ? '玻璃板' : '标准方块');
    const slotNo = targetSlot + 1;

    els.detail.innerHTML =
      '<div class="bd-card">'
      + '<div class="bd-icon"><i></i><span class="bd-num">#' + b.id + '</span></div>'
      + '<div class="bd-name">' + esc(b.name) + '</div>'
      + '<div class="bd-en">' + esc(b.en || '') + '</div>'
      + '<div class="bd-tags"><span class="bd-tag main">' + esc(grpCn) + '</span>'
      + '<span class="bd-tag">' + esc(catCn) + '</span></div>'
      + '<dl class="bd-rows">'
      + '<div><dt>硬度</dt><dd>' + hard + '</dd></div>'
      + '<div><dt>透光</dt><dd>' + (b.transparent ? '是' : '否') + '</dd></div>'
      + '<div><dt>形状</dt><dd>' + geom + '</dd></div>'
      + '</dl>'
      + '<button class="bd-put" id="bdPut">放入第 ' + slotNo + ' 格</button>'
      + '<p class="bd-tip">也可以点下方的格子，换一格再放</p>'
      + '</div>';

    const icon = els.detail.querySelector('.bd-icon i');
    paint(icon, b.id, DETAIL_ICON);

    const put = els.detail.querySelector('#bdPut');
    if (put) put.onclick = () => take(b.id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------- 交互

  function take(id) {
    if (!cfg) return;
    cfg.onChange(targetSlot, id);
    detailId = id;
    renderHotbar();
    renderDetail();
    const b = window.BLOCK_BY_ID[id];
    els.hint.textContent = '已放入第 ' + (targetSlot + 1) + ' 格：' + (b ? b.name : id);
    els.hint.classList.add('flash');
    clearTimeout(take._t);
    take._t = setTimeout(() => els.hint.classList.remove('flash'), 900);
  }

  function sync() {
    if (!isOpen) return;
    renderHotbar();
  }

  async function open(slotIndex) {
    if (!cfg) return;
    targetSlot = (slotIndex >= 0 && slotIndex < 9) ? slotIndex : cfg.getActive();

    isOpen = true;
    document.getElementById('bag').classList.remove('hidden');
    document.body.classList.add('bag-open');

    await ensureAtlas();

    const active = cfg.getSlots()[targetSlot];
    detailId = active || 0;
    els.hint.textContent = '点击物品放进选中的格子';

    renderCats();
    renderGrid();
    renderHotbar();
    renderDetail();

    setTimeout(() => { try { els.search.focus(); } catch (e) { /* noop */ } }, 30);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    document.getElementById('bag').classList.add('hidden');
    document.body.classList.remove('bag-open');
    els.search.value = '';
    query = '';
    els.clear.classList.add('hidden');
  }

  // ---------------------------------------------------------------- 初始化

  function init(opts) {
    cfg = opts || {};

    els = {
      root: $('bag'),
      cats: $('bagCats'),
      grid: $('bagGrid'),
      empty: $('bagEmpty'),
      count: $('bagCount'),
      detail: $('bagDetail'),
      hotbar: $('bagHotbar'),
      search: $('bagSearch'),
      clear: $('bagClear'),
      hint: $('bagHint'),
    };
    if (!els.root) return;

    // 分类
    els.cats.addEventListener('click', (e) => {
      const btn = e.target.closest('.bag-cat');
      if (!btn) return;
      group = btn.dataset.g;
      [...els.cats.children].forEach((c) => c.classList.toggle('on', c.dataset.g === group));
      renderGrid();
      els.grid.scrollTop = 0;
    });

    // 网格：悬停看信息，点击放入
    els.grid.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.bag-item');
      if (!el) return;
      const id = +el.dataset.id;
      if (id === detailId) return;
      detailId = id;
      renderDetail();
    });

    els.grid.addEventListener('click', (e) => {
      const el = e.target.closest('.bag-item');
      if (!el) return;
      const id = +el.dataset.id;
      els.grid.querySelectorAll('.bag-item.pick').forEach((n) => n.classList.remove('pick'));
      el.classList.add('pick');
      take(id);
    });

    // 底部快捷栏：切换要放入的格子
    els.hotbar.addEventListener('click', (e) => {
      const el = e.target.closest('.bag-slot');
      if (!el) return;
      targetSlot = +el.dataset.i;
      renderHotbar();
      renderDetail();
    });

    // 搜索
    let timer = null;
    els.search.addEventListener('input', () => {
      query = els.search.value;
      els.clear.classList.toggle('hidden', !query);
      clearTimeout(timer);
      timer = setTimeout(() => { renderGrid(); els.grid.scrollTop = 0; }, 110);
    });

    els.clear.onclick = () => {
      els.search.value = '';
      query = '';
      els.clear.classList.add('hidden');
      renderGrid();
      els.search.focus();
    };

    $('bagClose').onclick = () => { if (cfg.onClose) cfg.onClose(); };
    els.root.addEventListener('mousedown', (e) => {
      if (e.target === els.root && cfg.onClose) cfg.onClose();
    });

    // 图集 blob 编码 4096² 要几百毫秒，趁世界还没开始跑先备好，别让第一次按 E 卡一下
    const warm = () => { ensureAtlas(); };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(warm, { timeout: 6000 });
    } else {
      setTimeout(warm, 1800);
    }
  }

  window.Bag = { init, open, close, sync, isOpen: () => isOpen };
})();
