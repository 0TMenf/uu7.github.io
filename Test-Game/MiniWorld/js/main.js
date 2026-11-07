/**
 * 主程序：把渲染、世界、玩家、联机、界面组装起来
 */

(async function () {
  // --- 加载进度：真实工作只有读图集，先把进度条跑起来别让页面干等 ---
  const loadEl = document.getElementById('loading');
  const loadFill = document.getElementById('loadFill');
  const loadPct = document.getElementById('loadPct');

  let loadValue = 0;
  function setLoad(v) {
    loadValue = Math.min(100, Math.max(loadValue, v));
    const p = Math.round(loadValue);
    if (loadFill) loadFill.style.width = p + '%';
    if (loadPct) loadPct.textContent = String(p);
  }
  // 进度条跟着真实加载走（blocks.json → geometry.json → 537 张贴图），
  // 只保留一点点向上爬的兜底，避免某一批特别慢时看着像卡死
  const loadTimer = setInterval(() => {
    const real = 6 + (window.__atlasProgress || 0) * 86;
    setLoad(Math.max(real, loadValue + 0.35));
  }, 70);

  // 图集要先异步读一遍 textures/blocks，读不到的用程序生成的兜底
  const atlasCanvas = await window.buildAtlas();
  window.HAS_OVERLAY = !!atlasCanvas.hasOverlay;

  // 内容层（物品/合成/生物/粒子/电路）在页面加载时已并行发请求，
  // 这里等它读完，再用已填充的 BLOCKS 重建「物品 ID ↔ 方块 ID」映射。
  if (window.Content && window.Content.ready) {
    try { await window.Content.ready; } catch (e) { console.warn('[内容层] 加载失败', e); }
  }
  if (window.Content && window.Content.reindexBlocks) window.Content.reindexBlocks();
  if (window.Inventory) window.Inventory.init({ mode: 'creative' });

  // 群系表来自原版 biomedef.csv（草色 / 树密度 / 顶层块）
  const biomes = await fetch('./data/biomes.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  console.log('[群系] 载入 ' + biomes.length + ' 个');

  const canvas = document.getElementById('game');

  // 体素游戏边缘本来就是硬边，关掉 MSAA 省下的填充率很可观
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
    });
  } catch (e) {
    // 服务器环境常见：没有显卡驱动，浏览器也没开软件渲染
    console.error('[WebGL] 初始化失败', e);
    const loading = document.getElementById('loading');
    if (loading) loading.classList.add('hidden');
    document.body.classList.add('ready');
    const dlg = document.getElementById('nameDialog');
    if (dlg) dlg.classList.remove('hidden');
    const msg = document.getElementById('lobbyMsg');
    if (msg) {
      msg.innerHTML = '这台机器没有可用的 WebGL。服务器环境需要在浏览器里开启软件渲染，<br>'
        + '例如 Chrome 加参数 <code>--enable-unsafe-swiftshader</code>，否则页面跑不起来。';
    }
    throw e;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.0));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  // 阴影贴图常开，靠 sun.castShadow 控制是否真的渲染这一趟（避免运行时重编译材质）
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // 认一下显卡：核显在 1080p 上带不动大视距，首次进入时给个不卡的默认值
  const gpuName = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch { return ''; }
  })();
  const softwareGPU = /SwiftShader|llvmpipe|Software|Basic Render/i.test(gpuName);
  const weakGPU = softwareGPU
    || /UHD Graphics 6\d\d|HD Graphics \d{3}|Mali-|Adreno [3-6]|PowerVR/i.test(gpuName);
  console.log('[GPU] ' + (gpuName || '未知')
    + (softwareGPU ? '（CPU 软渲染，默认最低视距）' : weakGPU ? '（核显，默认低视距）' : ''));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9FDBF3);
  scene.fog = new THREE.Fog(0xBFE9F7, 30, 52);

  const camera = new THREE.PerspectiveCamera(
    72, window.innerWidth / window.innerHeight, 0.08, 120
  );

  const hemi = new THREE.HemisphereLight(0xE4F6FF, 0x6B8F5A, 0.92);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xFFFFFF, 0.72);
  sun.position.set(70, 120, 45);
  scene.add(sun);

  // 阴影：正交相机跟着玩家走，覆盖周围 96 格
  sun.castShadow = false;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -48;
  sun.shadow.camera.right = 48;
  sun.shadow.camera.top = 48;
  sun.shadow.camera.bottom = -48;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;

  // --- 材质 ---
  const atlasTex = new THREE.CanvasTexture(atlasCanvas);
  // 原版贴图是 128px 的手绘素材，不是像素风，用线性过滤更自然；
  // 图集很大（4096），各向异性开到 8 能缓解地面斜视时的模糊。
  atlasTex.magFilter = THREE.LinearFilter;
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  atlasTex.encoding = THREE.sRGBEncoding;

  const blockMat = new THREE.MeshBasicMaterial({
    map: atlasTex,
    vertexColors: true,
    alphaTest: 0.08,
    side: THREE.FrontSide,
  });

  // 均衡 / 精细档换成能吃阴影的 Lambert；流畅档仍用不受光的 Basic
  const blockMatLit = new THREE.MeshLambertMaterial({
    map: atlasTex,
    vertexColors: true,
    alphaTest: 0.08,
    side: THREE.FrontSide,
  });
  let activeMat = blockMat;
  let shadowsOn = false;

  console.log('[材质] 图集 ' + window.ATLAS_SIZE + 'px，' + (atlasCanvas.customTiles || 0)
    + ' 张原版贴图' + (atlasCanvas.missingTiles ? '，' + atlasCanvas.missingTiles + ' 张缺失' : ''));

  // --- 昼夜 ---
  const dayCycle = new window.DayCycle(scene, sun, hemi, scene.fog, blockMat);

  // 夜里给玩家一点微光，否则完全看不见脚下
  const eyeLight = new THREE.PointLight(0xBBD0FF, 0, 15, 2);
  scene.add(eyeLight);

  // 挖掘时叠在方块上的暗色方块，进度越满越黑
  const crackMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
  });
  const crackBox = new THREE.Mesh(new THREE.BoxGeometry(1.006, 1.006, 1.006), crackMat);
  crackBox.visible = false;
  scene.add(crackBox);

  // --- 世界与玩家 ---
  let world = null;
  const player = new Player(camera, { isSolid: () => false });
  const net = new Net();

  // --- 选中高亮 ---
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: 0x102018, transparent: true, opacity: 0.42 })
  );
  highlight.visible = false;
  scene.add(highlight);

  // --- 界面 ---
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const NO_PAUSE = params.get('nopause') === '1';

  const lobby = $('lobby');
  const hud = $('hud');
  const nameInput = $('nameInput');
  const enterBtn = $('enterBtn');
  const lobbyMsg = $('lobbyMsg');
  const nameDialog = $('nameDialog');
  const hotbarEl = $('hotbar');
  const debugEl = $('debug');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const chatLog = $('chatLog');
  const pausedEl = $('paused');
  const helpEl = $('help');

  let currentBlock = window.PLACEABLE[0];
  let chatOpen = false;
  let started = false;
  let codexInited = false;     // 图鉴只需建一次 DOM，返回主界面再进来不重复绑定
  let gameMode = 'creative';   // creative | survival
  let entryMode = 'solo';      // solo | multi（主菜单选的是哪个入口）
  let timeFrozen = false;
  let frames = 0, fpsTime = 0, fps = 0;

  // ---------------------------------------------------------------- 热键栏

  function blockIcon(id) {
    const def = window.BLOCK_BY_ID[id];
    const tile = window.tileOf(def, 'top');
    const gx = tile % window.ATLAS_GRID;
    const gy = Math.floor(tile / window.ATLAS_GRID);
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    // 128 → 32 是缩小，走平滑才不会出现锯齿
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      atlasCanvas,
      gx * window.ATLAS_CELL + window.ATLAS_PAD,
      gy * window.ATLAS_CELL + window.ATLAS_PAD,
      window.TILE, window.TILE,
      0, 0, 32, 32
    );
    return c.toDataURL();
  }

  function buildHotbar() {
    hotbarEl.innerHTML = '';
    window.PLACEABLE.forEach((id, i) => {
      const slot = document.createElement('button');
      slot.className = 'slot' + (id === currentBlock ? ' active' : '');
      slot.style.backgroundImage = `url(${blockIcon(id)})`;
      slot.title = window.BLOCK_BY_ID[id] ? window.BLOCK_BY_ID[id].name : '';
      slot.innerHTML = `<span class="num">${i + 1}</span>`;
      slot.onclick = () => selectBlock(id);
      slot.oncontextmenu = (ev) => { ev.preventDefault(); openPicker(i); };
      hotbarEl.appendChild(slot);
    });
    syncSlotLabel();
    if (window.Bag) window.Bag.sync();
  }

  // 快捷栏上方常驻一条名字，替代原来每次切换都弹的 toast
  function syncSlotLabel() {
    const el = $('slotLabel');
    if (!el) return;
    const b = window.BLOCK_BY_ID[currentBlock];
    if (!b) {
      el.classList.remove('show');
      return;
    }
    el.textContent = b.name;
    el.classList.add('show');
  }

  function selectBlock(id) {
    currentBlock = id;
    [...hotbarEl.children].forEach((el, i) => {
      el.classList.toggle('active', window.PLACEABLE[i] === id);
    });
    if (window.Inventory) window.Inventory.select(Math.max(0, window.PLACEABLE.indexOf(id)));
    syncSlotLabel();
    if (window.Bag) window.Bag.sync();
  }

  // ---------------------------------------------------------------- 提示

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  function chatLine(html, cls) {
    const div = document.createElement('div');
    div.className = 'chatline' + (cls ? ' ' + cls : '');
    div.innerHTML = html;
    chatLog.appendChild(div);
    while (chatLog.children.length > 7) chatLog.removeChild(chatLog.firstChild);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 24000);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------- 玩家列表

  function renderPlayerList(players) {
    const box = $('playerList');
    box.innerHTML = '';
    players.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'pl-item' + (p.id === net.id ? ' me' : '');
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = `hsl(${(parseInt(hashHex(p.name), 16) % 360)},58%,58%)`;
      const nm = document.createElement('span');
      nm.textContent = p.name;
      item.append(sw, nm);
      box.appendChild(item);
    });
    $('onlineCount').textContent = `${players.length} 人在线`;
  }

  // ---------------------------------------------------------------- 区块流

  function updateChunks(budgetMs) {
    const pcx = Math.floor(player.pos.x / window.SX);
    const pcz = Math.floor(player.pos.z / window.SZ);
    const todo = [];
    const R = window.VIEW_RADIUS;

    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const c = world.chunks.get(world.key(cx, cz));
        if (!c || c.dirty) todo.push({ cx, cz, d: dx * dx + dz * dz });
      }
    }
    if (!todo.length) return;
    todo.sort((a, b) => a.d - b.d);

    // 按时间预算来建，避免一帧里连建多个区块把主线程堵死
    const t0 = performance.now();
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      world.rebuildChunk(world.ensureChunk(t.cx, t.cz));
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  // ---------------------------------------------------------------- 进入世界

  // 防重入：快速双击 / 回车连按会让 enter() 跑两遍，服务器上就多出几个"幽灵玩家"
  let entering = false;

  async function enter() {
    if (entering) return;

    const name = nameInput.value.trim();
    if (!name) {
      lobbyMsg.textContent = '先起个名字吧';
      nameInput.focus();
      return;
    }
    entering = true;
    try { localStorage.setItem('mw_name', name); } catch { /* 隐私模式下忽略 */ }

    enterBtn.disabled = true;
    enterBtn.textContent = '正在连接…';
    lobbyMsg.textContent = '';
    if (window.SFX) window.SFX.unlock();

    try {
      const init = await net.connect(name);

      world = new World(scene, init.seed, activeMat, biomes);
      world.setShadows(shadowsOn);
      // 服务器下发的既有改动，走 setBlock 焊进区块数据
      (init.edits || []).forEach(([x, y, z, b]) => world.setBlock(x, y, z, b));

      // --- 内容层运行时：粒子 / 生物 / 电路 / 物品 / 图鉴 ---
      if (window.Mobs) window.Mobs.clear();
      if (window.Particles) window.Particles.clear();
      if (window.Particles) window.Particles.init(scene);
      if (window.Mobs) window.Mobs.init({ scene, world });
      if (window.Redstone) {
        window.Redstone.init({
          scene, world,
          onChange: (x, y, z, b) => {
            world.setBlock(x, y, z, b);
            net.sendEdit(x, y, z, b);
            window.Redstone.onEdit(x, y, z, b);
          },
        });
        (init.edits || []).forEach(([x, y, z, b]) => window.Redstone.onEdit(x, y, z, b));
      }
      if (window.Inventory) window.Inventory.setMode(gameMode);
      if (!codexInited && window.Codex) {
        codexInited = true;
        window.Codex.init({
          atlasCanvas,
          onGive: (id, n) => {
            const r = window.Inventory.give(id, n);
            buildHotbar();
            return r;
          },
          onCraft: (recipe) => {
            const r = window.Inventory.craft(recipe);
            buildHotbar();
            return r;
          },
          onSpawnMob: (id) => {
            if (!world || !window.Mobs) return 0;
            const f = new THREE.Vector3(); camera.getWorldDirection(f);
            const x = Math.floor(player.pos.x + f.x * 5);
            const z = Math.floor(player.pos.z + f.z * 5);
            return window.Mobs.spawn(id, x, null, z) ? 1 : 0;
          },
          onPlayParticle: (id) => {
            if (!world || !window.Particles) return 0;
            const f = new THREE.Vector3(); camera.getWorldDirection(f);
            return window.Particles.spawn(id,
              Math.floor(player.pos.x + f.x * 3),
              Math.floor(player.pos.y),
              Math.floor(player.pos.z + f.z * 3));
          },
          onDemoCircuit: () => {
            if (!world || !window.Redstone) return 0;
            const f = new THREE.Vector3(); camera.getWorldDirection(f);
            const bx = Math.floor(player.pos.x + f.x * 4);
            const bz = Math.floor(player.pos.z + f.z * 4);
            let by = 40;
            try { by = Math.floor(world.heightAt(bx, bz)) + 1; } catch (e) { /* 用兜底 */ }
            return window.Redstone.placeDemo(bx, by, bz);
          },
          onToast: (m) => toast(m),
        });
      }

      // 出生点附近先同步铺好，避免一脚踩空掉下去
      const sx = Math.floor(init.spawn.x), sz = Math.floor(init.spawn.z);
      const scx = Math.floor(sx / window.SX), scz = Math.floor(sz / window.SZ);
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          world.ensureChunk(scx + dx, scz + dz);
        }
      }

      player.world = world;

      // 出生点选在"靠水又平坦"的地方：随机落点可能是整片内陆，走几百格都见不到水。
      // heightAt 是纯函数，不依赖区块，所以可以直接在方圆 96 格内打分。
      function chooseSpawn(baseX, baseZ) {
        const bx = Math.floor(baseX), bz = Math.floor(baseZ);
        const SEA = window.SEA_LEVEL;

        // 有的种子整片大陆几百格都没水，所以先由近到远粗扫，找到最近的湖
        let lake = null;
        for (const step of [16, 32, 64]) {
          const R = step * 12;               // 192 / 384 / 768 格
          for (let dz = -R; dz <= R; dz += step) {
            for (let dx = -R; dx <= R; dx += step) {
              const x = bx + dx, z = bz + dz;
              if (world.heightAt(x, z) >= SEA) continue;
              const d = dx * dx + dz * dz;
              if (!lake || d < lake.d) lake = { x, z, d };
            }
          }
          if (lake) break;
        }
        if (!lake) return { x: baseX, z: baseZ, waterDist: 99 };

        // 湖岸 6-48 格里挑一块最平、离水 18 格左右的干地
        let best = null;
        for (let dz = -48; dz <= 48; dz += 6) {
          for (let dx = -48; dx <= 48; dx += 6) {
            const x = lake.x + dx, z = lake.z + dz;
            const h = world.heightAt(x, z);
            if (h <= SEA + 1 || h > 36) continue;

            const slope = Math.max(
              Math.abs(h - world.heightAt(x + 2, z)),
              Math.abs(h - world.heightAt(x, z + 2))
            );
            const distToWater = Math.max(Math.abs(dx), Math.abs(dz));
            const score = -Math.abs(distToWater - 18) * 1.5 - slope * 8;
            if (!best || score > best.score) {
              best = { x: x + 0.5, z: z + 0.5, waterDist: distToWater, score };
            }
          }
        }
        return best || { x: lake.x + 0.5, z: lake.z + 0.5, waterDist: 0 };
      }

      // 如果还是落在水里，往外找一块干地
      function pickSpawn(x, z) {
        const dry = (tx, tz) => {
          world.ensureChunk(tx >> 4, tz >> 4);
          const feet = player.findSpawn(tx + 0.5, tz + 0.5);
          const b = world.getBlock(tx, Math.floor(feet), tz);
          return (b === 12 || b === 0) ? null : feet;   // 水里或悬空都不算
        };

        let y = dry(Math.floor(x), Math.floor(z));
        if (y !== null) return { x, z, y };

        for (let r = 4; r <= 40; r += 4) {
          for (let a = 0; a < 12; a++) {
            const ang = (a / 12) * Math.PI * 2 + r * 0.7;
            const tx = Math.floor(x + Math.cos(ang) * r);
            const tz = Math.floor(z + Math.sin(ang) * r);
            const yy = dry(tx, tz);
            if (yy !== null) return { x: tx + 0.5, z: tz + 0.5, y: yy };
          }
        }
        return { x, z, y: player.findSpawn(x, z) };
      }

      const site = chooseSpawn(init.spawn.x, init.spawn.z);
      const sp = pickSpawn(site.x, site.z);
      player.pos.set(sp.x, sp.y + 0.2, sp.z);
      console.log('[出生点] 离水 ' + (site.waterDist < 99 ? site.waterDist + ' 格' : '附近没有水'));

      if (typeof init.hours === 'number') dayCycle.setHours(init.hours);

      // ?hour=22 直接把时间定住，方便看夜晚效果
      const hParam = parseFloat(params.get('hour'));
      if (!isNaN(hParam)) {
        dayCycle.setHours(hParam);
        dayCycle.enabled = false;
        timeFrozen = true;
      }

      net.spawnRemotes(scene, init.players || []);

      const all = [{ id: init.id, name: init.name }, ...(init.players || [])];
      renderPlayerList(all);

      lobby.classList.add('hidden');
      if (window.__hideLobby) window.__hideLobby();

      // 应用创造 / 生存
      player.mode = gameMode;
      player.flying = false;
      player.healAll();
      healthEl.classList.toggle('hidden', gameMode !== 'survival');
      paintHealth();
      hud.classList.remove('hidden');

      buildHotbar();
      started = true;
      lockPointer();

      // 暴露一份给调试用，方便在控制台看渲染开销
      window.__game = { world, player, net, renderer, scene, camera, dayCycle, fps: 0 };

      chatLine(`欢迎，<b>${esc(init.name)}</b>。你所在的房间有 ${all.length} 人。`, 'sys');
      toast('左键挖、右键放');

      // 演示模式：自动搭一小段结构，用来验证放置与网格重建链路
      if (params.get('demo') === '1') {
        setTimeout(() => {
          const bx = Math.floor(player.pos.x);
          const by = Math.floor(player.pos.y);
          const bz = Math.floor(player.pos.z);
          for (let i = 0; i < 4; i++) {
            world.setBlock(bx + 3, by + i, bz - 4, i === 3 ? 9 : 3);
            net.sendEdit(bx + 3, by + i, bz - 4, i === 3 ? 9 : 3);
          }
          for (let i = 0; i < 3; i++) {
            world.setBlock(bx + 2 + i, by + 3, bz - 5, 7);
            net.sendEdit(bx + 2 + i, by + 3, bz - 5, 7);
          }
          toast('演示结构已搭好');
        }, 600);
      }
    } catch (err) {
      entering = false;
      // 连接失败时把昵称面板拉出来，否则错误信息没地方显示
      nameDialog.classList.remove('hidden');
      lobbyMsg.textContent = err.message || '连接失败';
      enterBtn.disabled = false;
      enterBtn.textContent = '进入世界';
    }
  }

  // ---------------------------------------------------------------- 指针锁定

  function lockPointer() {
    if (document.pointerLockElement !== canvas) {
      // 新版 Chrome 的 requestPointerLock 返回 Promise；没有用户手势时会 reject，
      // 不接住就会变成一条未处理的异常（无头浏览器里很常见）
      try {
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* 浏览器不支持就算了 */ }
    }
  }

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    // 锁定状态一变就清空按键，否则 Esc 之后回来会一直自己走
    if (!locked) player.resetKeys();
    player.enabled = locked && !chatOpen;
    pausedEl.classList.toggle('hidden', locked || !started || chatOpen || bagOpen || codexOpen || NO_PAUSE);
  });

  window.addEventListener('blur', () => player.resetKeys());

  let miningActive = false;
  const mining = { key: '', progress: 0, total: 0 };
  const crosshairEl = document.getElementById('crosshair');
  const fpsBadgeEl = document.getElementById('fpsBadge');
  const clockEl = document.getElementById('clockText');
  const dayIconEl = document.getElementById('dayIcon');

  canvas.addEventListener('mousedown', (e) => {
    if (!started) return;
    if (document.pointerLockElement !== canvas) {
      lockPointer();
      return;
    }
    if (e.button === 0) miningActive = true;
    if (e.button === 2) doPlace(e);
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      miningActive = false;
      resetMining();
    }
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- 方块操作

  function doBreakAt(hit) {
    if (!hit) return;
    if (hit.y <= 0) return;                     // 最底层不动
    const broken = world.getBlock(hit.x, hit.y, hit.z);
    world.setBlock(hit.x, hit.y, hit.z, 0);
    net.sendEdit(hit.x, hit.y, hit.z, 0);
    if (window.SFX) window.SFX.breakBlock(window.SND_DIG[broken]);
    if (window.Particles) window.Particles.burstBreak(hit.x, hit.y, hit.z, broken);
    if (window.Redstone) window.Redstone.onEdit(hit.x, hit.y, hit.z, 0);
  }

  function resetMining() {
    mining.key = '';
    mining.progress = 0;
    mining.total = 0;
    crackBox.visible = false;
    crosshairEl.classList.remove('mining');
  }

  // 按住左键持续挖，硬度决定耗时（对齐原版 BLOCKATTR.hardness）
  function updateMining(dt) {
    if (!miningActive || !player.enabled) { resetMining(); return; }

    const hit = player.raycast(7);
    if (!hit) { resetMining(); return; }

    const id = world.getBlock(hit.x, hit.y, hit.z);
    const hard = window.HARDNESS[id];
    if (!(hard > 0)) { resetMining(); return; }   // 基岩 -1 / 水 0 / 空气

    const key = hit.x + ',' + hit.y + ',' + hit.z;
    if (key !== mining.key) {
      mining.key = key;
      mining.progress = 0;
      // 创造模式瞬间破坏；生存模式按硬度算耗时
      mining.total = (player.mode === 'creative')
        ? 0.02
        : Math.max(0.12, hard * window.DIG_FACTOR);
    }

    mining.progress += dt;
    if (window.SFX) window.SFX.dig(window.SND_DIG[id]);

    if (mining.progress >= mining.total) {
      doBreakAt(hit);
      resetMining();
      return;
    }

    const t = mining.progress / mining.total;
    crackBox.visible = true;
    crackBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    crackMat.opacity = 0.12 + t * 0.42;

    crosshairEl.classList.add('mining');
    crosshairEl.style.setProperty('--p', t.toFixed(3));
  }

  function doPlace(ev) {
    const hit = player.raycast(7);
    if (!hit) return;

    // 右键对准开关 / 按钮：切换电路状态（按住 Shift 强制放置）
    if (!(ev && ev.shiftKey) && window.Redstone
      && window.Redstone.toggle(hit.x, hit.y, hit.z)) {
      toast('电路已切换');
      return;
    }

    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    if (y < 0 || y >= window.SY) return;
    if (world.getBlock(x, y, z) !== 0) return;
    if (!currentBlock) return;
    if (window.Inventory && gameMode === 'survival' && !window.Inventory.active().count) {
      toast('这一格没有方块了');
      return;
    }

    // 别把自己埋进方块里
    const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    const overlapX = Math.abs(x + 0.5 - px) < 0.8;
    const overlapZ = Math.abs(z + 0.5 - pz) < 0.8;
    const overlapY = y + 1 > py + 0.05 && y < py + 1.78;
    if (overlapX && overlapZ && overlapY) return;

    world.setBlock(x, y, z, currentBlock);
    net.sendEdit(x, y, z, currentBlock);
    if (window.SFX) window.SFX.place(window.SND_WALK[currentBlock]);
    if (window.Particles) window.Particles.burstPlace(x, y, z, currentBlock);
    if (window.Redstone) window.Redstone.onEdit(x, y, z, currentBlock);
    if (window.Inventory) window.Inventory.consumeActive();
  }

  // ---------------------------------------------------------------- 背包

  let bagOpen = false;
  let codexOpen = false;

  if (window.Bag) {
    window.Bag.init({
      atlasCanvas,
      getSlots: () => (window.Inventory ? window.Inventory.getSlots() : window.PLACEABLE),
      getActive: () => (window.Inventory
        ? window.Inventory.getActive()
        : Math.max(0, window.PLACEABLE.indexOf(currentBlock))),
      onChange: (slot, id) => {
        if (window.Inventory) window.Inventory.setSlot(slot, id);
        else window.PLACEABLE[slot] = id;
        buildHotbar();
        selectBlock(id);
      },
      onClose: () => closePicker(),
    });
  }

  function openPicker(slot) {
    if (bagOpen || codexOpen || !started) return;
    bagOpen = true;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    player.enabled = false;
    pausedEl.classList.add('hidden');
    if (window.Bag) window.Bag.open(slot);
  }

  function closePicker() {
    if (!bagOpen) return;
    bagOpen = false;
    if (window.Bag) window.Bag.close();
    if (!chatOpen) lockPointer();
  }

  function openCodex() {
    if (codexOpen || bagOpen || !started || !window.Codex) return;
    codexOpen = true;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    player.enabled = false;
    pausedEl.classList.add('hidden');
    window.Codex.open();
  }

  function closeCodex() {
    if (!codexOpen) return;
    codexOpen = false;
    if (window.Codex) window.Codex.close();
    if (!chatOpen) lockPointer();
  }

  const invBtn = $('invBtn');
  if (invBtn) invBtn.onclick = () => openPicker(window.PLACEABLE.indexOf(currentBlock));
  const codexBtn = $('codexBtn');
  if (codexBtn) codexBtn.onclick = () => openCodex();

  // ---------------------------------------------------------------- 键盘

  window.addEventListener('keydown', (e) => {
    if (!started) return;

    if (codexOpen) {
      if (e.code === 'Escape') { e.preventDefault(); closeCodex(); }
      return;
    }

    if (bagOpen) {
      if (e.code === 'Escape') closePicker();
      return;
    }

    if (e.code === 'KeyC' && !chatOpen) {
      e.preventDefault();
      openCodex();
      return;
    }

    if ((e.code === 'KeyE' || e.code === 'KeyB') && !chatOpen) {
      e.preventDefault();
      openPicker(window.PLACEABLE.indexOf(currentBlock));
      return;
    }

    if (e.code === 'KeyT' && !chatOpen) {
      e.preventDefault();
      chatOpen = true;
      player.enabled = false;
      chatForm.classList.remove('hidden');
      chatInput.focus();
      return;
    }

    if (chatOpen) {
      if (e.code === 'Escape') {
        chatOpen = false;
        chatForm.classList.add('hidden');
        chatInput.blur();
        player.enabled = document.pointerLockElement === canvas;
      }
      return;
    }

    if (e.code === 'Escape') {
      helpEl.classList.add('hidden');
      return;
    }

    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) {
      const id = window.PLACEABLE[n - 1];
      if (id !== undefined) selectBlock(id);
    }
  });

  window.addEventListener('wheel', (e) => {
    if (!started || chatOpen || bagOpen || codexOpen) return;
    const idx = window.PLACEABLE.indexOf(currentBlock);
    const next = (idx + (e.deltaY > 0 ? 1 : -1) + window.PLACEABLE.length) % window.PLACEABLE.length;
    selectBlock(window.PLACEABLE[next]);
  }, { passive: true });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (msg) net.sendChat(msg);
    chatInput.value = '';
    chatOpen = false;
    chatForm.classList.add('hidden');
    chatInput.blur();
    player.enabled = document.pointerLockElement === canvas;
  });

  // ---------------------------------------------------------------- 联机事件

  net.on('join', (m) => {
    net.addRemote(m);
    chatLine(`${esc(m.name)} 加入了世界`, 'sys');
    if (world) toast(`${m.name} 来了`);
  });

  net.on('leave', (m) => {
    const r = net.remotes.get(m.id);
    if (r) chatLine(`${esc(r.name)} 离开了`, 'sys');
    net.removeRemote(m.id);
  });

  net.on('move', (m) => {
    const r = net.remotes.get(m.id);
    if (r) r.setTarget(m.x, m.y, m.z, m.yaw);
  });

  net.on('edit', (m) => {
    if (world) world.setBlock(m.x, m.y, m.z, m.b);
    if (window.Redstone) window.Redstone.onEdit(m.x, m.y, m.z, m.b);
  });

  net.on('chat', (m) => {
    chatLine(`<b>${esc(m.name)}</b> ${esc(m.msg)}`);
  });

  // 服务器每 5 秒校一次表，差得多才硬拉，避免时间跳变
  net.on('time', (m) => {
    if (!started || timeFrozen || typeof m.hours !== 'number') return;
    let diff = m.hours - dayCycle.hours;
    while (diff > 12) diff -= 24;
    while (diff < -12) diff += 24;
    if (Math.abs(diff) > 0.2) dayCycle.setHours(m.hours);
  });

  net.on('disconnect', () => {
    if (!started) return;
    toast('与服务器断开');
    chatLine('连接已断开，刷新页面可重连。', 'sys');
    player.enabled = false;
  });

  // ---------------------------------------------------------------- 按钮

  function openNameDialog(title) {
    const h = nameDialog.querySelector('h3');
    if (title && h) h.textContent = title;
    nameDialog.classList.remove('hidden');
    setTimeout(() => nameInput.focus(), 30);
  }

  // 「点击进入游戏」不再直接连服，先展开主菜单
  function onStart() {
    if (window.SFX) window.SFX.unlock();
    mainMenu.classList.remove('hidden');
  }

  const mainMenu = $('mainMenu');

  [...mainMenu.querySelectorAll('.mm-card')].forEach((card) => {
    card.onclick = () => {
      const mode = card.dataset.mode;
      if (card.classList.contains('soon')) {
        toast('「' + card.querySelector('b').textContent + '」还在建设中');
        return;
      }
      entryMode = mode === 'multi' ? 'multi' : 'solo';
      mainMenu.classList.add('hidden');
      if (!nameInput.value.trim()) { openNameDialog('起个名字'); return; }
      enter();
    };
  });

  $('mmBack').onclick = () => mainMenu.classList.add('hidden');

  // --- 创造 / 生存 ---
  const healthEl = $('healthBar');
  const healthPips = [...healthEl.children];

  function paintHealth() {
    const seg = player.maxHp / healthPips.length;    // 20 点血分 10 格
    healthPips.forEach((pip, i) => {
      pip.classList.toggle('off', player.hp <= i * seg);
    });
  }

  [...document.querySelectorAll('.mode-btn')].forEach((btn) => {
    btn.onclick = () => {
      gameMode = btn.dataset.mode;
      [...document.querySelectorAll('.mode-btn')].forEach((b) => {
        b.classList.toggle('on', b === btn);
      });
    };
  });

  player.onHurt = () => paintHealth();
  player.onRespawn = () => {
    paintHealth();
    toast('你被摔晕了，已经送回出生点');
  };
  player.onFlyToggle = (on) => toast(on ? '飞行开启：空格上升 / Shift 下降' : '飞行关闭');

  // 暂停 → 返回主界面：断开连接、清掉世界、回到大厅
  $('toLobbyBtn').onclick = () => {
    if (net.close) net.close();
    started = false;
    // 面板和运行时都要收干净，否则再进一次会残留上一局的灯、粒子和生物
    if (window.Bag) window.Bag.close();
    if (window.Codex) window.Codex.close();
    bagOpen = false; codexOpen = false; chatOpen = false;
    if (window.Mobs) window.Mobs.clear();
    if (window.Particles) window.Particles.clear();
    if (window.Redstone) window.Redstone.dispose();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    pausedEl.classList.add('hidden');
    hud.classList.add('hidden');
    settingsEl.classList.add('hidden');
    if (world) {
      for (const c of world.chunks.values()) {
        if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
      }
      world.chunks.clear();
      world = null;
    }
    net.remotes.forEach((r) => { if (r.group) scene.remove(r.group); });
    net.remotes.clear();
    lobby.classList.remove('hidden');
    mainMenu.classList.remove('hidden');
    entering = false;
    enterBtn.disabled = false;
    enterBtn.textContent = '进入世界';
  };

  window.__onStart = onStart;
  window.__openNameDialog = openNameDialog;

  enterBtn.onclick = enter;
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  $('cancelName').onclick = () => nameDialog.classList.add('hidden');

  // 记住上次用的昵称
  try {
    const saved = localStorage.getItem('mw_name');
    if (saved) nameInput.value = saved.slice(0, 16);
  } catch { /* 忽略 */ }

  $('resumeBtn').onclick = () => lockPointer();
  $('btnHelp').onclick = () => helpEl.classList.remove('hidden');
  $('closeHelp').onclick = () => helpEl.classList.add('hidden');
  pausedEl.onclick = (e) => { if (e.target === pausedEl) lockPointer(); };

  // --- 设置：音量 / 灵敏度 / 视距 / 画面质量 / 垂直同步 ---
  const settingsEl = $('settings');
  const vsyncToggle = $('vsyncToggle');
  const vsyncState = $('vsyncState');
  const volRange = $('volRange');
  const volVal = $('volVal');
  const sensRange = $('sensRange');
  const sensVal = $('sensVal');
  const viewRange = $('viewRange');
  const viewVal = $('viewVal');
  const qualitySeg = $('qualitySeg');

  const EXTREME_VIEW = 24;       // 超远视距：384 格，给截图/压力测试用
  const extremeToggle = $('extremeToggle');

  const prefs = {
    volume: 0.7,
    sens: 1,
    view: Math.max(2, Math.min(16, window.VIEW_RADIUS || 3)),
    quality: 1,
    vsync: true,
    extreme: false,
  };

  function savePrefs() {
    try { localStorage.setItem('mw_prefs', JSON.stringify(prefs)); } catch { /* 忽略 */ }
  }

  function applyVolume() {
    if (window.SFX) window.SFX.setVolume(prefs.volume);
    volVal.textContent = String(Math.round(prefs.volume * 100));
  }

  function applySensitivity() {
    player.sensitivityScale = prefs.sens;
    sensVal.textContent = Math.round(prefs.sens * 100) + '%';
  }

  // 视距变小时把远处的网格释放掉，但保留方块数据 ——
  // 数据丢了的话，自己改过的方块在走回来时就没了。
  function pruneChunks(r) {
    if (!world) return;
    const pcx = Math.floor(player.pos.x / window.SX);
    const pcz = Math.floor(player.pos.z / window.SZ);
    const keep = r + 2;           // 多留两圈，避免站在边界上来回走时反复重建
    for (const c of world.chunks.values()) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) <= keep) continue;
      if (c.mesh) {
        scene.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh = null;
      }
      c.dirty = true;
    }
  }

  function applyView() {
    const r = prefs.extreme ? EXTREME_VIEW : prefs.view;
    window.VIEW_RADIUS = r;

    viewVal.textContent = prefs.extreme ? EXTREME_VIEW + ' 区块（极限）' : prefs.view + ' 区块';
    viewRange.disabled = prefs.extreme;
    extremeToggle.classList.toggle('on', !!prefs.extreme);

    // 雾和远裁剪面必须跟着视距走，否则调大视距也只是一片更远的雾
    const dist = r * 16;
    scene.fog.near = dist * 0.55;
    scene.fog.far = dist * 1.02;
    camera.near = r >= 12 ? 0.15 : 0.08;
    camera.far = Math.min(900, dist * 1.15 + 30);
    camera.updateProjectionMatrix();

    // 星星放到远裁剪面里侧，否则大视距时会被裁掉
    if (dayCycle && dayCycle.setStarRadius) dayCycle.setStarRadius(camera.far * 0.95);

    pruneChunks(r);
  }

  function applyQuality() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prefs.quality));
    renderer.setSize(window.innerWidth, window.innerHeight);

    // 流畅档没有阴影；均衡 1024，精细 2048
    shadowsOn = prefs.quality >= 1;
    activeMat = shadowsOn ? blockMatLit : blockMat;

    if (world) {
      world.setMaterial(activeMat);
      world.setShadows(shadowsOn);
    }
    if (dayCycle && dayCycle.setShadowMode) {
      dayCycle.setShadowMode(shadowsOn, prefs.quality >= 1.35 ? 2048 : 1024);
    }

    [...qualitySeg.children].forEach((b) => {
      b.classList.toggle('on', Math.abs(parseFloat(b.dataset.q) - prefs.quality) < 0.01);
    });
  }

  function setVsync(on) {
    // 先掐掉旧的调度，否则会同时存在两套循环
    cancelAnimationFrame(rafId);
    clearTimeout(timerId);
    vsyncEnabled = on;
    schedule();

    vsyncToggle.classList.toggle('on', on);
    vsyncState.textContent = on ? '当前：跟随刷新率' : '当前：已解除限制，帧率不设上限';
  }

  $('settingsBtn').onclick = () => {
    settingsEl.classList.remove('hidden');
    pausedEl.classList.add('hidden');
  };
  $('closeSettings').onclick = () => {
    settingsEl.classList.add('hidden');
    pausedEl.classList.remove('hidden');
  };

  volRange.oninput = () => {
    prefs.volume = volRange.value / 100;
    applyVolume();
    savePrefs();
  };
  sensRange.oninput = () => {
    prefs.sens = sensRange.value / 100;
    applySensitivity();
    savePrefs();
  };
  viewRange.oninput = () => {
    prefs.view = parseInt(viewRange.value, 10);
    applyView();
    savePrefs();
  };
  qualitySeg.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    prefs.quality = parseFloat(btn.dataset.q);
    applyQuality();
    savePrefs();
  };
  extremeToggle.onclick = () => {
    prefs.extreme = !prefs.extreme;
    applyView();
    savePrefs();
    toast(prefs.extreme ? '超远视距 24 区块，正在铺区块…' : '已恢复 ' + prefs.view + ' 区块视距');
  };

  vsyncToggle.onclick = () => {
    prefs.vsync = !vsyncEnabled;
    setVsync(prefs.vsync);
    savePrefs();
    toast(prefs.vsync ? '垂直同步已开启' : '垂直同步已关闭');
  };

  function loadPrefs() {
    let saved = null;
    try {
      saved = localStorage.getItem('mw_prefs');
      if (saved) Object.assign(prefs, JSON.parse(saved));
    } catch { /* 配置损坏就用默认值 */ }

    // 第一次来 + 弱显卡：核显给 4 区块，CPU 软渲染给 2 区块，都是流畅档
    if (!saved && weakGPU) {
      prefs.view = softwareGPU ? 2 : 4;
      prefs.quality = 0.75;
    }

    // ?vd=24 这类参数优先于存档，方便直接甩一个链接测视距
    const vdParam = parseInt(params.get('vd'), 10);
    if (vdParam >= 1) {
      prefs.extreme = vdParam > 16;
      prefs.view = Math.max(2, Math.min(16, vdParam));
    }

    prefs.view = Math.max(2, Math.min(16, prefs.view | 0 || 3));
    prefs.extreme = !!prefs.extreme;
    prefs.quality = [0.75, 1, 1.35].includes(prefs.quality) ? prefs.quality : 1;

    volRange.value = String(Math.round(prefs.volume * 100));
    sensRange.value = String(Math.round(prefs.sens * 100));
    viewRange.value = String(prefs.view);

    applyVolume();
    applySensitivity();
    applyView();
    applyQuality();
    setVsync(prefs.vsync !== false);
  }

  // ---------------------------------------------------------------- 循环

  const clock = new THREE.Clock();
  let lastPrune = 0;
  let stepAcc = 0;      // 走路音的累计距离

  // 垂直同步：开启时跟随屏幕刷新率（requestAnimationFrame），
  // 关闭后改用 setTimeout 驱动，帧率不再被 vsync 卡住（可能撕裂）
  let vsyncEnabled = true;
  let rafId = 0, timerId = 0;

  function schedule() {
    if (vsyncEnabled) rafId = requestAnimationFrame(animate);
    else timerId = setTimeout(animate, 0);
  }

  function animate() {
    schedule();

    const dt = Math.min(clock.getDelta(), 0.1);

    if (started && world) {
      player.update(dt);

      // 走路音：按走过的距离触发，跑起来更密。脚下是什么方块就响什么。
      if (player.onGround && !player.flying && world) {
        const sp = Math.hypot(player.vel.x, player.vel.z);
        if (sp > 0.8) {
          stepAcc += sp * dt;
          if (stepAcc > (sp > 6 ? 1.55 : 1.95)) {
            stepAcc = 0;
            const fx = Math.floor(player.pos.x);
            const fz = Math.floor(player.pos.z);
            const below = world.getBlock(fx, Math.floor(player.pos.y - 0.5), fz);
            if (below && window.SFX) window.SFX.step(window.SND_WALK[below]);
            if (below && window.Particles) window.Particles.step(fx, Math.floor(player.pos.y - 0.5), fz);
          }
        } else {
          stepAcc = 1.2;      // 停下后让下一次起步很快出声
        }
      }

      // 昼夜推进 + 夜间跟身微光
      dayCycle.update(dt, player.pos);
      eyeLight.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
      eyeLight.intensity = Math.max(0, 0.45 - sun.intensity) * 2.0;
      eyeLight.visible = eyeLight.intensity > 0.02;   // 白天关掉，省一次光照计算

      // 时钟每帧更新，别等 0.5 秒统计周期
      clockEl.textContent = dayCycle.clockText;
      dayIconEl.classList.toggle('night', !dayCycle.isDaytime);

      updateMining(dt);

      // 内容层运行时：粒子池 / 电路网络 / 生物漫游
      if (window.Particles) window.Particles.update(dt);
      if (window.Redstone) window.Redstone.update(dt, player.pos);
      if (window.Mobs) window.Mobs.update(dt, player.pos);

      net.sendMove(player.pos, player.yaw);
      net.updateRemotes(dt);

      updateChunks(prefs.extreme ? 12 : 7);

      // 每 3 秒回收一次远处网格（保留方块数据），否则一直走会越来越卡
      if (performance.now() - lastPrune > 3000) {
        lastPrune = performance.now();
        pruneChunks(window.VIEW_RADIUS);
      }

      // 选中框
      const hit = player.enabled ? player.raycast(7) : null;
      if (hit) {
        highlight.visible = true;
        highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      } else {
        highlight.visible = false;
      }

      frames++;
      fpsTime += dt;
      if (fpsTime >= 0.5) {
        fps = Math.round(frames / fpsTime);
        frames = 0; fpsTime = 0;
        if (window.__game) window.__game.fps = fps;

        // 左上角无背景帧率
        fpsBadgeEl.textContent = 'FPS : ' + fps;

        const p = player.pos;
        const pbx = Math.floor(p.x), pbz = Math.floor(p.z);
        const pbi = world.biomeIndexAt(pbx, pbz, world.heightAt(pbx, pbz));
        const pb = world.biomes[pbi];
        debugEl.textContent =
          `XYZ ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
          `批次 ${renderer.info.render.calls}　三角 ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
          `区块 ${world.chunks.size}　在线 ${net.remotes.size + 1}\n` +
          `群系 ${pb ? pb.name + ' ' + pb.grass : '—'}`;
      }
    } else {
      player.update(0);
      dayCycle.update(dt, player.pos);
    }

    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 开场先给个能转的镜头，别让登录页背后一片黑
  player.pos.set(8, 42, 8);
  player.pitch = -0.15;
  animate();

  // 必须在循环启动之后再应用设置：applyView / setVsync 会重排调度，
  // 放在前面会和手动启动的 animate() 叠成两套循环。
  loadPrefs();

  // 资源就绪，收掉加载层
  setLoad(100);
  clearInterval(loadTimer);
  setTimeout(() => {
    if (loadEl) loadEl.classList.add('done');
    document.body.classList.add('ready');     // 淡入"点击进入游戏"
  }, 420);
  setTimeout(() => { if (loadEl) loadEl.classList.add('hidden'); }, 1100);

  // 支持 ?name=xxx 直接进服，方便自测和分享固定昵称
  const autoName = params.get('name');
  if (autoName) {
    nameInput.value = autoName.slice(0, 16);
    enter();
  }
})().catch((err) => {
  console.error('[启动失败]', err);
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');
  document.body.classList.add('ready');
  const dlg = document.getElementById('nameDialog');
  if (dlg) dlg.classList.remove('hidden');
  const msg = document.getElementById('lobbyMsg');
  if (msg) msg.textContent = '启动失败：' + (err && err.message ? err.message : err);
});
