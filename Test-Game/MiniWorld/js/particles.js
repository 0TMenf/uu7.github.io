/**
 * 粒子系统
 * ---------------------------------------------------------------
 * 634 个原版特效定义 + 407 张原版粒子贴图（由 gen_content.py 抽取）。
 * .emo 的完整发射器参数不做 1:1 逆向，按 CSV 分类（烟雾/爆炸/光效/粒子/
 * 火焰/环境/提示）套运动预设，贴图和发射器数量取自 .emo 本身。
 *
 * 一个 emitter = 一个 THREE.Points，池化复用，最多同时 24 个。
 */
(function () {
  'use strict';

  const P = {
    ready: false,
    scene: null,
    pool: [],
    active: [],
    texCache: new Map(),
    defaultTex: null,
    max: 24,
    lastId: 0,
    stats: { active: 0, spawned: 0 },
  };

  const PRESET_FALLBACK = {
    color: '#ffffff', mode: 'spark', spread: 0.8, rise: 0.6, life: 1.1,
  };

  function texture(name) {
    if (!name) return P.defaultTex;
    if (P.texCache.has(name)) return P.texCache.get(name);
    const t = new THREE.TextureLoader().load(
      (window.Content ? window.Content.particleTexURL(name) : './textures/particles/' + name),
      undefined,
      () => { /* 缺图就用默认白点 */ }
    );
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    P.texCache.set(name, t);
    return t;
  }

  function makeDefaultTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(16, 16, 1, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  function init(scene) {
    P.scene = scene;
    if (!P.defaultTex) P.defaultTex = makeDefaultTexture();
    P.ready = true;
    return P;
  }

  function acquire() {
    if (P.active.length >= P.max) {
      const oldest = P.active.shift();
      oldest.points.visible = false;
      P.pool.push(oldest);
    }
    let e = P.pool.pop();
    if (!e) {
      const n = 96;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setDrawRange(0, 0);
      const mat = new THREE.PointsMaterial({
        size: 0.26, map: P.defaultTex, transparent: true, opacity: 1,
        depthWrite: false, vertexColors: true, sizeAttenuation: true,
        blending: THREE.NormalBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 5;
      P.scene.add(points);
      e = { points, geo, mat, parts: [], count: 0, life: 0, maxLife: 1, loop: false, preset: null, tex: '' };
    }
    e.points.visible = true;
    return e;
  }

  function release(e) {
    e.points.visible = false;
    e.count = 0;
    e.parts.length = 0;
    e.geo.setDrawRange(0, 0);
    const i = P.active.indexOf(e);
    if (i >= 0) P.active.splice(i, 1);
    P.pool.push(e);
  }

  /**
   * 播放一个特效。
   * @param effectId  particles.json 的 ID；传 0/找不到时用 opts 里的自定义参数
   * @param opts { x,y,z, count, color, loop, scale }
   */
  function spawn(effectId, x, y, z, opts) {
    if (!P.ready || !window.THREE) return 0;
    opts = opts || {};
    const def = window.Content && window.Content.particleById.get(+effectId);
    const preset = opts.preset
      || (def && window.Content.presets[def.type])
      || PRESET_FALLBACK;
    const colorHex = opts.color || preset.color || '#ffffff';

    const e = acquire();
    e.preset = preset;
    e.loop = !!opts.loop || (def && def.mode === 1);
    e.maxLife = (opts.life || preset.life || 1.1);
    e.life = 0;
    // 循环特效不能永远占着池子，给一个总时长上限
    e.total = 0;
    e.maxDuration = e.loop ? (opts.maxDuration || 5) : Infinity;
    e.scale = opts.scale || 1;

    const texName = def && def.textures && def.textures.length
      ? def.textures[0] : (opts.texture || '');
    const tex = texture(texName);
    if (tex !== e.mat.map) { e.mat.map = tex; e.mat.needsUpdate = true; }
    e.mat.blending = (preset.mode === 'glow' || preset.mode === 'flame' || preset.mode === 'spark')
      ? THREE.AdditiveBlending : THREE.NormalBlending;
    e.mat.size = (preset.mode === 'smoke' || preset.mode === 'ambient' ? 0.42 : 0.26) * e.scale;
    e.mat.opacity = 1;

    const count = Math.min(96, opts.count || Math.max(12, (def ? def.emitters : 1) * 26));
    const col = new THREE.Color(colorHex);
    const pos = e.geo.attributes.position.array;
    const clr = e.geo.attributes.color.array;
    const spread = preset.spread || 0.8;
    const rise = preset.rise || 0.6;
    const burst = preset.mode === 'burst';

    e.parts.length = 0;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (burst ? 1.0 : 0.45);
      const speed = (burst ? 2.6 : 0.7) * (0.5 + Math.random());
      e.parts.push({
        x: (Math.random() - 0.5) * 0.3,
        y: Math.random() * 0.25,
        z: (Math.random() - 0.5) * 0.3,
        vx: Math.cos(a) * r * speed * spread,
        vy: (burst ? Math.random() * 1.6 : rise) * (0.4 + Math.random() * 0.9),
        vz: Math.sin(a) * r * speed * spread,
        born: Math.random() * 0.25,
        bright: 0.65 + Math.random() * 0.35,
      });
      const k = i * 3;
      pos[k] = e.parts[i].x; pos[k + 1] = e.parts[i].y; pos[k + 2] = e.parts[i].z;
      clr[k] = col.r * e.parts[i].bright;
      clr[k + 1] = col.g * e.parts[i].bright;
      clr[k + 2] = col.b * e.parts[i].bright;
    }
    e.count = count;
    e.geo.setDrawRange(0, count);
    e.geo.attributes.position.needsUpdate = true;
    e.geo.attributes.color.needsUpdate = true;
    e.points.position.set(x + 0.5, y + 0.5, z + 0.5);
    e.points.visible = true;
    P.active.push(e);
    P.stats.spawned++;
    P.stats.active = P.active.length;
    P.lastId = +effectId || 0;
    return count;
  }

  /** 破坏方块：用方块小地图色做碎屑 */
  function burstBreak(x, y, z, blockId) {
    const c = window.MAP_COLOR && window.MAP_COLOR[blockId];
    return spawn(0, x, y, z, {
      color: c || '#c9b48a', count: 26, life: 0.75, scale: 0.8,
      preset: { color: c || '#c9b48a', mode: 'burst', spread: 1.1, rise: 0.5, life: 0.75 },
    });
  }

  function burstPlace(x, y, z, blockId) {
    const c = window.MAP_COLOR && window.MAP_COLOR[blockId];
    return spawn(0, x, y, z, {
      color: c || '#e8f3d0', count: 12, life: 0.5, scale: 0.6,
      preset: { color: c || '#e8f3d0', mode: 'spark', spread: 0.5, rise: 0.5, life: 0.5 },
    });
  }

  function step(x, y, z) {
    return spawn(0, x, y, z, {
      color: '#d8d2bd', count: 6, life: 0.45, scale: 0.5,
      preset: { color: '#d8d2bd', mode: 'smoke', spread: 0.35, rise: 0.35, life: 0.45 },
    });
  }

  function update(dt) {
    if (!P.ready) return;
    const d = Math.min(dt, 0.05);
    for (let i = P.active.length - 1; i >= 0; i--) {
      const e = P.active[i];
      e.life += d;
      e.total += d;
      if (e.total >= e.maxDuration) { release(e); continue; }
      const preset = e.preset || PRESET_FALLBACK;
      const pos = e.geo.attributes.position.array;
      const gravity = preset.mode === 'burst' ? -3.2 : (preset.mode === 'spark' ? -1.1 : 0.15);
      const drag = 0.97;

      if (e.loop && e.life >= e.maxLife) {
        // 循环特效：重置粒子位置，不销毁
        e.life = 0;
        for (let j = 0; j < e.count; j++) {
          const p = e.parts[j];
          p.x = (Math.random() - 0.5) * 0.3;
          p.y = Math.random() * 0.25;
          p.z = (Math.random() - 0.5) * 0.3;
          p.born = Math.random() * 0.25;
        }
      }

      const t = e.life / e.maxLife;
      for (let j = 0; j < e.count; j++) {
        const p = e.parts[j];
        if (e.life < p.born) continue;
        p.vy += gravity * d;
        p.vx *= drag; p.vz *= drag;
        p.x += p.vx * d;
        p.y += p.vy * d;
        p.z += p.vz * d;
        if (preset.mode === 'flame') { p.x *= 0.985; p.z *= 0.985; }
        const k = j * 3;
        pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
      }
      e.geo.attributes.position.needsUpdate = true;
      e.mat.opacity = Math.max(0, 1 - t * t);
      if (!e.loop && e.life >= e.maxLife) release(e);
    }
    P.stats.active = P.active.length;
  }

  function clear() {
    for (let i = P.active.length - 1; i >= 0; i--) release(P.active[i]);
  }

  function dispose() {
    clear();
    for (const e of P.pool) {
      P.scene.remove(e.points);
      e.geo.dispose(); e.mat.dispose();
    }
    P.pool.length = 0;
    P.ready = false;
  }

  window.Particles = Object.assign(P, {
    init, spawn, burstBreak, burstPlace, step, update, clear, dispose, texture,
  });
})();
