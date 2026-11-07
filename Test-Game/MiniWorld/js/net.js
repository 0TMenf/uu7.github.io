/**
 * 联机：WebSocket 通道 + 其他玩家的方块人形象
 */

class RemotePlayer {
  constructor(scene, id, name, x, y, z) {
    this.id = id;
    this.name = name;
    this.target = new THREE.Vector3(x, y, z);
    this.targetYaw = 0;
    this.group = new THREE.Group();

    const hue = (parseInt(hashHex(name), 16) % 360);
    this.color = new THREE.Color().setHSL(hue / 360, 0.55, 0.52);

    const mat = new THREE.MeshLambertMaterial({ color: this.color });
    const skin = new THREE.MeshLambertMaterial({ color: 0xf0c9a0 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2c3b32 });

    // 身体
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.28), mat);
    body.position.y = 1.02;
    this.group.add(body);

    // 头
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), skin);
    head.position.y = 1.56;
    this.group.add(head);

    // 头发
    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 0.48), dark);
    hair.position.y = 1.76;
    this.group.add(hair);

    // 四肢
    const armGeo = new THREE.BoxGeometry(0.16, 0.56, 0.16);
    this.armL = new THREE.Mesh(armGeo, mat);
    this.armL.position.set(-0.33, 1.05, 0);
    this.armR = new THREE.Mesh(armGeo, mat);
    this.armR.position.set(0.33, 1.05, 0);
    this.group.add(this.armL, this.armR);

    const legGeo = new THREE.BoxGeometry(0.18, 0.58, 0.18);
    this.legL = new THREE.Mesh(legGeo, dark);
    this.legL.position.set(-0.13, 0.42, 0);
    this.legR = new THREE.Mesh(legGeo, dark);
    this.legR.position.set(0.13, 0.42, 0);
    this.group.add(this.legL, this.legR);

    // 名字标签
    this.label = makeLabel(name);
    this.label.position.y = 2.06;
    this.group.add(this.label);

    this.group.position.copy(this.target);
    scene.add(this.group);

    this.walkPhase = 0;
  }

  setTarget(x, y, z, yaw) {
    this.target.set(x, y, z);
    if (typeof yaw === 'number') this.targetYaw = yaw;
  }

  update(dt) {
    const p = this.group.position;
    const before = p.clone();
    p.lerp(this.target, Math.min(1, dt * 12));

    // 朝向做角度插值，避免转身瞬移
    let diff = this.targetYaw - this.group.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y += diff * Math.min(1, dt * 10);

    // 走路摆臂
    const moved = p.distanceTo(before);
    if (moved > 0.002) {
      this.walkPhase += moved * 6;
      const s = Math.sin(this.walkPhase) * 0.5;
      this.legL.rotation.x = s;
      this.legR.rotation.x = -s;
      this.armL.rotation.x = -s * 0.7;
      this.armR.rotation.x = s * 0.7;
    } else {
      this.legL.rotation.x *= 0.85;
      this.legR.rotation.x *= 0.85;
      this.armL.rotation.x *= 0.85;
      this.armR.rotation.x *= 0.85;
    }
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}

function hashHex(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

function makeLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const pad = 12;
  const font = '600 30px system-ui, "Microsoft YaHei", sans-serif';

  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = w;
  canvas.height = 52;

  const c2 = canvas.getContext('2d');
  c2.font = font;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';

  c2.fillStyle = 'rgba(12,20,16,0.72)';
  roundRect(c2, 0, 4, w, 44, 12);
  c2.fill();

  c2.fillStyle = '#E9F5EC';
  c2.fillText(text, w / 2, 27);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  const scale = 0.011;
  sprite.scale.set(w * scale, 52 * scale, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

class Net {
  constructor() {
    this.ws = null;
    this.id = null;
    this.remotes = new Map();
    this.scene = null;
    this.handlers = {};

    this.lastSent = 0;
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  _emit(name, ...args) {
    if (this.handlers[name]) this.handlers[name](...args);
  }

  // 主动断开：回主界面时用，不要再触发 disconnect 回调（那是掉线处理）
  close() {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* 已断开 */ }
    }
    this.id = 0;
    if (this.scene) {
      this.remotes.forEach((r) => { if (r.group) this.scene.remove(r.group); });
    }
    this.remotes.clear();
  }

  connect(name) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // /ws 是 Cloudflare Worker 的 Durable Object 入口；
      // 本地 Node 服务端的 upgrade 不校验路径，所以同一份客户端两边都能连。
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', name }));
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('无法连接服务器'));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this._emit('disconnect');
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.t === 'init') {
          clearTimeout(timeout);
          this.id = m.id;
          this.seed = m.seed;
          resolve(m);
          return;
        }
        if (m.t === 'full') {
          clearTimeout(timeout);
          reject(new Error('服务器已满'));
          return;
        }
        this._emit(m.t, m);
      };
    });
  }

  spawnRemotes(scene, list) {
    this.scene = scene;
    list.forEach((p) => this.addRemote(p));
  }

  addRemote(p) {
    if (!this.scene || p.id === this.id) return;
    if (this.remotes.has(p.id)) return;
    this.remotes.set(p.id, new RemotePlayer(this.scene, p.id, p.name, p.x, p.y, p.z));
  }

  removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.dispose(this.scene);
    this.remotes.delete(id);
  }

  updateRemotes(dt) {
    for (const r of this.remotes.values()) r.update(dt);
  }

  sendMove(pos, yaw) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const now = performance.now();
    if (now - this.lastSent < 80) return;      // 12.5Hz 足够
    this.lastSent = now;
    this.ws.send(JSON.stringify({
      t: 'move', x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2), yaw: +yaw.toFixed(3),
    }));
  }

  sendEdit(x, y, z, b) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ t: 'edit', x, y, z, b }));
  }

  sendChat(msg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ t: 'chat', msg }));
  }
}

window.Net = Net;
window.RemotePlayer = RemotePlayer;
window.makeLabel = makeLabel;
