/**
 * 电路（电石）信号网络
 * ---------------------------------------------------------------
 * 数据来自 circuits.json（29 个原版元件，按 role 归类）。
 * 世界是无限的，不能全图扫描，所以只在 onEdit 时登记电路方块坐标；
 * 也会定期扫描玩家周围一小片区域，接上世界里本来就有的电路块。
 *
 * 支持：常供电（电石块）、开关、按钮脉冲、导线衰减、增幅器（中继器）、
 *       比较器衰减、信号灯、机械臂。信号以 6 邻接 BFS 传播。
 */
(function () {
  'use strict';

  const R = {
    ready: false,
    scene: null,
    world: null,
    onChange: null,
    rules: { maxSignal: 15, wireLoss: 1, buttonPulseMs: 900, tickMs: 80, maxNodes: 4096 },
    nodes: new Map(),      // key → { x,y,z,role,signal,active,until }
    lamps: new Map(),      // key → THREE.Mesh
    dirty: true,
    lastScan: 0,
    stats: { nodes: 0, powered: 0, lampsOn: 0, sources: 0 },
  };

  const K = (x, y, z) => x + ',' + y + ',' + z;
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function roleOf(b) {
    const c = window.Content && window.Content.circuitByBlock.get(b);
    return c ? c.role : '';
  }

  function init(opts) {
    R.scene = opts.scene;
    R.world = opts.world;
    R.onChange = opts.onChange || null;
    R.rules = Object.assign(R.rules, (window.Content && window.Content.rules) || {});
    R.nodes.clear();
    clearLamps();
    R.ready = true;
    R.dirty = true;
    return R;
  }

  function clearLamps() {
    if (!R.scene) return;
    for (const m of R.lamps.values()) {
      R.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    R.lamps.clear();
  }

  /** 方块变化时调用（挖掉、放下、联机同步都走这里） */
  function onEdit(x, y, z, b) {
    if (!R.ready) return;
    const key = K(x, y, z);
    const role = roleOf(b);
    if (role) {
      const old = R.nodes.get(key);
      R.nodes.set(key, {
        x, y, z, role, signal: 0,
        active: role === 'source' ? true : (old ? old.active : false),
        until: old ? old.until : 0,
      });
    } else {
      R.nodes.delete(key);
      const lamp = R.lamps.get(key);
      if (lamp && R.scene) R.scene.remove(lamp);
      R.lamps.delete(key);
    }
    R.dirty = true;
  }

  /** 交互点开关、按钮 */
  function toggle(x, y, z) {
    const n = R.nodes.get(K(x, y, z));
    if (!n) return false;
    if (n.role === 'source' || n.role === 'wire' || n.role === 'lamp') return false;
    if (n.role === 'button' || n.role === 'pressure') {
      n.active = true;
      n.until = performance.now() + (R.rules.buttonPulseMs || 900);
    } else {
      n.active = !n.active;
      n.until = 0;
    }
    R.dirty = true;
    return true;
  }

  /** 扫描玩家附近已有电路块（世界生成/联机同步来的） */
  function scanAround(cx, cy, cz, radius) {
    if (!R.world) return;
    const r = Math.min(radius || 20, 24);
    let added = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if ((dx * dx + dz * dz) > r * r) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (y < 0) continue;
          const key = K(x, y, z);
          if (R.nodes.has(key)) continue;
          const role = roleOf(R.world.getBlock(x, y, z));
          if (!role) continue;
          R.nodes.set(key, {
            x, y, z, role, signal: 0,
            active: role === 'source', until: 0,
          });
          added++;
          if (added > 400) return;
        }
      }
    }
    if (added) R.dirty = true;
  }

  /** BFS：从电源/激活的开关出发，沿导线传播 */
  function compute() {
    for (const n of R.nodes.values()) n.signal = 0;

    const max = R.rules.maxSignal || 15;
    const loss = R.rules.wireLoss || 1;
    const queue = [];
    let sources = 0;

    for (const n of R.nodes.values()) {
      if (n.role === 'source' || (n.active && (n.role === 'switch' || n.role === 'button' || n.role === 'pressure'))) {
        n.signal = max;
        queue.push(n);
        sources++;
      }
    }

    const visited = new Set();
    let steps = 0;
    const cap = R.rules.maxNodes || 4096;

    while (queue.length && steps++ < cap * 6) {
      const cur = queue.shift();
      const out = cur.signal - loss;
      if (out <= 0) continue;
      for (const [dx, dy, dz] of NB) {
        const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
        const next = R.nodes.get(K(nx, ny, nz));
        if (!next) continue;
        if (next.role === 'source' || next.role === 'switch' || next.role === 'button') continue;

        let sig = out;
        if (next.role === 'repeater') sig = max;
        else if (next.role === 'comparator') sig = Math.max(1, out - 1);

        const vk = K(nx, ny, nz) + '|' + cur.role;
        if (visited.has(vk)) continue;
        visited.add(vk);

        if (sig <= next.signal) continue;
        next.signal = sig;
        if (next.role === 'wire' || next.role === 'repeater' || next.role === 'comparator') {
          queue.push(next);
        }
      }
    }

    syncLamps();
    let powered = 0, lampsOn = 0;
    for (const n of R.nodes.values()) {
      if (n.signal > 0) powered++;
      if (n.signal > 0 && (n.role === 'lamp' || n.role === 'piston')) lampsOn++;
    }
    R.stats = { nodes: R.nodes.size, powered, lampsOn, sources };
    R.dirty = false;
  }

  function syncLamps() {
    if (!R.scene || !window.THREE) return;
    for (const [key, n] of R.nodes) {
      const want = n.signal > 0 && (n.role === 'lamp' || n.role === 'piston' || n.role === 'sensor');
      let m = R.lamps.get(key);
      if (!want) {
        if (m) m.visible = false;
        continue;
      }
      if (!m) {
        m = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 8, 6),
          new THREE.MeshBasicMaterial({
            color: n.role === 'piston' ? 0xffc46b : 0xa6f06a,
            transparent: true, opacity: 0.95, depthWrite: false,
          })
        );
        m.position.set(n.x + 0.5, n.y + 1.16, n.z + 0.5);
        R.scene.add(m);
        R.lamps.set(key, m);
      }
      m.visible = true;
      const strength = Math.max(0.35, n.signal / (R.rules.maxSignal || 15));
      m.material.opacity = 0.35 + strength * 0.6;
      m.scale.setScalar(0.7 + strength * 0.6);
    }
  }

  function update(dt, playerPos) {
    if (!R.ready) return;
    const now = performance.now();
    let changed = false;
    for (const n of R.nodes.values()) {
      if (n.until && now > n.until) { n.active = false; n.until = 0; changed = true; }
    }
    if (playerPos && now - R.lastScan > 1500) {
      R.lastScan = now;
      scanAround(Math.floor(playerPos.x), Math.floor(playerPos.y), Math.floor(playerPos.z), 16);
    }
    if (R.dirty || changed) compute();
  }

  /** 在玩家面前摆一条可通电的演示电路：电石块—导线×2—开关—导线—信号灯 */
  function placeDemo(x, y, z) {
    if (!R.onChange) return 0;
    const pick = (role) => {
      const list = window.Content && window.Content.circuitByRole.get(role);
      return list && list.length ? list[0].id : 0;
    };
    const src = pick('source'), wire = pick('wire'), sw = pick('switch'), lamp = pick('lamp');
    if (!src || !wire || !sw || !lamp) return 0;
    const cells = [src, wire, wire, sw, wire, lamp];
    cells.forEach((b, i) => { if (b) R.onChange(x + i, y, z, b); });
    const n = R.nodes.get(K(x + 3, y, z));
    if (n) { n.active = true; R.dirty = true; }
    return cells.length;
  }

  function signal(x, y, z) {
    const n = R.nodes.get(K(x, y, z));
    return n ? n.signal : 0;
  }

  function dispose() {
    clearLamps();
    R.nodes.clear();
    R.ready = false;
  }

  window.Redstone = Object.assign(R, {
    init, onEdit, toggle, scanAround, compute, update, placeDemo, signal, dispose, roleOf,
  });
})();
