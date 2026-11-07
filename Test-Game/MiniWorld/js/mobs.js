/**
 * 生物
 * ---------------------------------------------------------------
 * 298 个原版生物定义（生命/攻击/速度/体型/类型/贴图目录）。
 *
 * .omod 是加密的 #Eg chunk 网格，骨骼蒙皮不在本次范围；这里按
 * monster.csv 的体型与类型生成体素拼装模型，能贴上原版 PNG 就贴，
 * 贴不上就用按类型算出的配色。带漫游、腿摆动、群体上限与自动补充。
 * 若 models.json 里将来有解析好的网格，会优先使用。
 */
(function () {
  'use strict';

  const M = {
    ready: false,
    scene: null,
    world: null,
    list: [],
    max: 24,
    auto: false,
    autoTimer: 0,
    texCache: new Map(),
    stats: { alive: 0, spawned: 0 },
  };

  const TYPE_SHAPE = {
    0: 'quadruped',   // 怪物
    1: 'quadruped',   // 动物
    2: 'quadruped',   // 稀有动物
    3: 'fish',        // 水生物
    4: 'quadruped',   // 移动工具
    5: 'humanoid',    // 村民 / NPC
    6: 'boss',        // boss
    7: 'humanoid',    // NPC
    8: 'bird',        // 飞行生物
    9: 'ball',        // 球
  };

  const TYPE_COLOR = {
    0: 0x6a4b6e, 1: 0xb98b57, 2: 0xd4a94a, 3: 0x4a9bb5, 4: 0x8c8f72,
    5: 0x9a7a5c, 6: 0x8b3540, 7: 0x7a8fa0, 8: 0xd9c46a, 9: 0xe1dcae,
  };

  function hue(id, base) {
    // 同类型不同生物给一点色相变化，免得一群全一个色
    const c = new THREE.Color(base);
    const h = {};
    c.getHSL(h);
    const d = ((id * 37) % 100) / 100 - 0.5;
    c.setHSL((h.h + d * 0.12 + 1) % 1, Math.min(1, h.s + d * 0.15), Math.max(0.18, Math.min(0.78, h.l + d * 0.12)));
    return c.getHex();
  }

  function mobTexture(model) {
    const C = window.Content;
    const files = model && C && C.mobTex[model];
    if (!files || !files.length) return null;
    // 优先不带 _emi / alpha 的彩色贴图
    const pick = files.find((f) => !/_emi|alpha|touming/i.test(f)) || files[0];
    const key = model + '/' + pick;
    if (M.texCache.has(key)) return M.texCache.get(key);
    const t = new THREE.TextureLoader().load(C.mobTexURL(model, pick));
    t.magFilter = THREE.NearestFilter;
    M.texCache.set(key, t);
    return t;
  }

  function init(opts) {
    M.scene = opts.scene;
    M.world = opts.world;
    M.ready = true;
    return M;
  }

  function box(w, h, d, color, map) {
    const mat = new THREE.MeshLambertMaterial({
      color, map: map || null, transparent: !!map,
    });
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  }

  function buildShape(def) {
    const shape = TYPE_SHAPE[def.type] || 'quadruped';
    const w = Math.max(0.35, Math.min(2.2, def.width || 0.9));
    const h = Math.max(0.45, Math.min(3.4, def.height || 1.6));
    const t = Math.max(0.35, Math.min(2.2, def.thick || 0.9));
    const base = hue(def.id, TYPE_COLOR[def.type] || 0xb98b57);
    const dark = new THREE.Color(base).multiplyScalar(0.72).getHex();
    const light = new THREE.Color(base).multiplyScalar(1.18).getHex();
    const tex = mobTexture(def.model);

    const g = new THREE.Group();
    const legs = [];
    let body;

    if (shape === 'humanoid') {
      body = box(w * 0.72, h * 0.42, t * 0.5, base, tex);
      body.position.y = h * 0.60;
      const head = box(w * 0.48, h * 0.28, t * 0.48, light);
      head.position.y = h * 0.95;
      g.add(body, head);
      for (const s of [-1, 1]) {
        const arm = box(w * 0.20, h * 0.36, t * 0.22, dark);
        arm.position.set(s * w * 0.48, h * 0.60, 0);
        g.add(arm);
        legs.push(arm);
        const leg = box(w * 0.24, h * 0.38, t * 0.26, dark);
        leg.position.set(s * w * 0.20, h * 0.20, 0);
        g.add(leg);
        legs.push(leg);
      }
    } else if (shape === 'bird' || shape === 'fish') {
      body = box(w * 0.9, shape === 'fish' ? h * 0.30 : h * 0.36, t * 1.15, base, tex);
      body.position.y = h * 0.5;
      const head = box(w * 0.42, h * 0.28, t * 0.42, light);
      head.position.set(0, h * 0.62, t * 0.62);
      g.add(body, head);
      for (const s of [-1, 1]) {
        const wing = box(w * 0.85, h * 0.08, t * 0.42, light);
        wing.position.set(s * w * 0.72, h * 0.58, 0);
        g.add(wing);
        legs.push(wing);
      }
      const tail = box(w * 0.5, h * 0.10, t * 0.5, dark);
      tail.position.set(0, h * 0.5, -t * 0.75);
      g.add(tail);
    } else if (shape === 'ball') {
      body = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(w, t) * 0.48, 12, 9),
        new THREE.MeshLambertMaterial({ color: base, map: tex || null, transparent: !!tex })
      );
      body.position.y = Math.max(w, t) * 0.48;
      g.add(body);
    } else {
      // quadruped / boss
      const len = Math.max(w, t) * (shape === 'boss' ? 1.5 : 1.25);
      body = box(w * 0.82, h * 0.36, len, base, tex);
      body.position.y = h * 0.62;
      const head = box(w * 0.56, h * 0.34, t * 0.55, light);
      head.position.set(0, h * 0.78, len * 0.62);
      g.add(body, head);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const leg = box(w * 0.20, h * 0.42, t * 0.20, dark);
          leg.position.set(sx * w * 0.32, h * 0.21, sz * len * 0.34);
          g.add(leg);
          legs.push(leg);
        }
      }
      if (shape !== 'boss') {
        const tail = box(w * 0.13, h * 0.10, t * 0.45, dark);
        tail.position.set(0, h * 0.74, -len * 0.64);
        g.add(tail);
      }
    }

    if (def.scale && def.scale !== 1) g.scale.setScalar(Math.max(0.4, Math.min(2.6, def.scale)));
    g.userData.legs = legs;
    g.userData.shape = shape;
    return g;
  }

  function groundAt(x, z, fallback) {
    if (!M.world || !M.world.heightAt) return fallback;
    try { return M.world.heightAt(Math.floor(x), Math.floor(z)) + 1; }
    catch (e) { return fallback; }
  }

  function spawn(mobId, x, y, z) {
    if (!M.ready || !window.Content || !window.THREE) return null;
    if (M.list.length >= M.max) despawn(M.list[0]);
    const def = window.Content.mobById.get(+mobId);
    if (!def) return null;

    const group = buildShape(def);
    const gy = (y == null) ? groundAt(x, z, 40) : y;
    group.position.set(x + 0.5, gy, z + 0.5);
    M.scene.add(group);

    const e = {
      id: +mobId, def, group,
      x: x + 0.5, y: gy, z: z + 0.5,
      vx: 0, vz: 0,
      timer: 0,
      turnIn: 1 + Math.random() * 3,
      phase: Math.random() * 6.28,
      speed: Math.max(0.4, Math.min(4, def.speed || 1)) * 1.1,
      flying: group.userData.shape === 'bird',
    };
    M.list.push(e);
    M.stats.spawned++;
    M.stats.alive = M.list.length;
    return e;
  }

  function despawn(e) {
    const i = M.list.indexOf(e);
    if (i < 0) return;
    M.list.splice(i, 1);
    M.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    M.stats.alive = M.list.length;
  }

  function randomPassive() {
    const pool = (window.Content.mobs || []).filter((m) =>
      (m.type === 1 || m.type === 2 || m.type === 8) && m.hp > 0
    );
    return pool.length ? pool[(Math.random() * pool.length) | 0].id : 0;
  }

  function spawnNear(playerPos, count) {
    const n = count || 1;
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const id = randomPassive();
      if (!id) break;
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 10;
      const x = Math.floor(playerPos.x + Math.cos(a) * r);
      const z = Math.floor(playerPos.z + Math.sin(a) * r);
      if (spawn(id, x, null, z)) ok++;
    }
    return ok;
  }

  function update(dt, playerPos) {
    if (!M.ready) return;
    const d = Math.min(dt, 0.05);

    for (const e of M.list) {
      e.timer += d;
      if (e.timer >= e.turnIn) {
        e.timer = 0;
        e.turnIn = 2 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2;
        const go = Math.random() < 0.78;
        e.vx = go ? Math.cos(a) * e.speed : 0;
        e.vz = go ? Math.sin(a) * e.speed : 0;
        // 换方向时重算一次地面高度（heightAt 很贵，不能每帧调）
        e.ground = groundAt(e.x, e.z, e.y);
      }
      e.x += e.vx * d;
      e.z += e.vz * d;
      if (playerPos) {
        const dx = e.x - playerPos.x, dz = e.z - playerPos.z;
        if (dx * dx + dz * dz > 55 * 55) { e.vx = -e.vx; e.vz = -e.vz; }
      }
      const gy = e.ground != null ? e.ground : e.y;
      e.group.position.set(e.x, gy + (e.flying ? 1.2 + Math.sin(e.phase + e.timer * 3) * 0.25 : 0), e.z);
      if (e.vx || e.vz) e.group.rotation.y = Math.atan2(e.vx, e.vz);

      e.phase += d * (2.5 + e.speed);
      const legs = e.group.userData.legs || [];
      for (let i = 0; i < legs.length; i++) {
        const sign = i % 2 ? 1 : -1;
        if (e.flying) legs[i].rotation.z = sign * (0.25 + Math.sin(e.phase * 2) * 0.35);
        else legs[i].rotation.x = Math.sin(e.phase + (i % 2) * Math.PI) * 0.35 * Math.min(1, e.speed);
      }
    }

    if (M.auto && playerPos) {
      M.autoTimer += d;
      if (M.autoTimer > 4) {
        M.autoTimer = 0;
        if (M.list.length < 8) spawnNear(playerPos, 1);
      }
    }
  }

  function setAuto(on) {
    M.auto = !!on;
    M.autoTimer = 0;
  }

  function summary() {
    return M.list.map((e) => ({ id: e.id, name: e.def.name, x: +e.x.toFixed(1), z: +e.z.toFixed(1) }));
  }

  function clear() {
    for (let i = M.list.length - 1; i >= 0; i--) despawn(M.list[i]);
  }

  function dispose() {
    clear();
    M.ready = false;
  }

  window.Mobs = Object.assign(M, {
    init, spawn, spawnNear, despawn, update, setAuto, summary, clear, dispose,
  });
})();
