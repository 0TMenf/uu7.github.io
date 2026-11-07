/**
 * 玩家：第一人称控制、AABB 碰撞、体素射线拾取
 */

const PLAYER_HALF = 0.3;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;

const GRAVITY = 28;
const JUMP_SPEED = 8.4;      // 约 1.25 格高
const WALK_SPEED = 4.6;
const RUN_SPEED = 7.0;
const AIR_CONTROL = 0.55;
const MAX_FALL = 42;

class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;

    this.pos = new THREE.Vector3(0.5, 40, 0.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;

    // 游戏模式：creative = 瞬间破坏 + 可飞行 + 无伤害；survival = 挖掘耗时 + 会摔伤
    this.mode = 'creative';
    this.flying = false;
    this.hp = 20;
    this.maxHp = 20;
    this.onHurt = null;          // 外部挂的回调（更新血条 / 死亡处理）
    this._lastSpace = 0;         // 双击空格切飞行
    this._fallPeak = 0;          // 起跳后的最高点，用来算坠落伤害

    this.keys = Object.create(null);
    this.sensitivity = 0.0022;
    this.sensitivityScale = 1;      // 设置面板里的灵敏度倍率
    this.enabled = false;

    this._bindInput();
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      // 创造模式下双击空格切飞行
      if (e.code === 'Space' && !e.repeat && this.enabled
          && this.mode === 'creative' && !this.keys.Space) {
        const now = performance.now();
        if (now - this._lastSpace < 320) {
          this.flying = !this.flying;
          this.vel.y = 0;
          if (this.onFlyToggle) this.onFlyToggle(this.flying);
          this._lastSpace = 0;
        } else {
          this._lastSpace = now;
        }
      }

      this.keys[e.code] = true;
      if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { this.keys = Object.create(null); });

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const s = this.sensitivity * this.sensitivityScale;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
  }

  /**
   * 指针锁定丢失时键盘事件会断掉，keyup 收不到，
   * 按键状态就会卡在"一直按着"。切出/切回时必须清一遍。
   */
  resetKeys() {
    this.keys = Object.create(null);
    this.vel.x = 0;
    this.vel.z = 0;
  }

  get eyePos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  get forward() {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }

  // --- 碰撞 ---

  collides(x, y, z) {
    const minX = Math.floor(x - PLAYER_HALF);
    const maxX = Math.floor(x + PLAYER_HALF);
    const minY = Math.floor(y + 0.001);
    const maxY = Math.floor(y + PLAYER_HEIGHT - 0.001);
    const minZ = Math.floor(z - PLAYER_HALF);
    const maxZ = Math.floor(z + PLAYER_HALF);

    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) {
          if (this.world.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  // 逐轴推进，碰壁就回退 —— 位移量很小，不会穿透
  _moveAxis(axis, amount) {
    if (amount === 0) return false;
    const p = this.pos;
    const old = p[axis];
    p[axis] = old + amount;

    if (this.collides(p.x, p.y, p.z)) {
      p[axis] = old;
      return true;
    }
    return false;
  }

  _hurt(amount) {
    if (amount <= 0 || this.mode !== 'survival') return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.onHurt) this.onHurt(this.hp, amount);
    if (this.hp <= 0) {
      // 死亡：回到出生点满血复活，暂时不做掉落
      this.hp = this.maxHp;
      this.vel.set(0, 0, 0);
      if (this.onRespawn) this.onRespawn();
    }
  }

  healAll() {
    this.hp = this.maxHp;
    if (this.onHurt) this.onHurt(this.hp, 0);
  }

  update(dt) {
    if (!this.enabled) {
      this.camera.position.copy(this.eyePos);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      return;
    }

    dt = Math.min(dt, 0.05);

    // 输入方向
    let fwd = 0, strafe = 0;
    if (this.keys.KeyW || this.keys.ArrowUp) fwd += 1;
    if (this.keys.KeyS || this.keys.ArrowDown) fwd -= 1;
    if (this.keys.KeyA || this.keys.ArrowLeft) strafe -= 1;
    if (this.keys.KeyD || this.keys.ArrowRight) strafe += 1;

    const len = Math.hypot(fwd, strafe);
    if (len > 0) { fwd /= len; strafe /= len; }

    const running = this.keys.ShiftLeft || this.keys.ShiftRight;
    const speed = running ? RUN_SPEED : WALK_SPEED;

    // 由 yaw 直接推出水平前向与右向，和相机朝向严格一致。
    // 不要再手写 ix/iz 的组合公式，那个很容易把正负号搞反。
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);

    const wishX = (fx * fwd + rx * strafe) * speed;
    const wishZ = (fz * fwd + rz * strafe) * speed;

    const accel = (this.onGround || this.flying) ? 1 : AIR_CONTROL;
    this.vel.x += (wishX - this.vel.x) * Math.min(1, 18 * dt * accel);
    this.vel.z += (wishZ - this.vel.z) * Math.min(1, 18 * dt * accel);

    if (this.mode === 'creative' && this.flying) {
      // 飞行：空格上升、Shift 下降，松手悬停
      const up = (this.keys.Space ? 1 : 0)
        - ((this.keys.ShiftLeft || this.keys.ShiftRight) ? 1 : 0);
      this.vel.y += (up * RUN_SPEED - this.vel.y) * Math.min(1, 14 * dt);
    } else {
      if (this.keys.Space && this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < -MAX_FALL) this.vel.y = -MAX_FALL;
    }

    // 位移
    const hitY = this._moveAxis('y', this.vel.y * dt);
    if (hitY) {
      if (this.vel.y < 0) {
        if (!this.onGround && this.mode === 'survival') {
          const fall = this._fallPeak - this.pos.y;
          // 3.5 格以内不疼，之后每格扣 1 点（和原版手感接近）
          if (fall > 3.5) this._hurt(Math.round((fall - 3.5) * 1.2));
        }
        this.onGround = true;
        this._fallPeak = this.pos.y;
      }
      this.vel.y = 0;
    } else if (this.vel.y < -0.2) {
      this.onGround = false;
    }

    // 记录空中最高点，落地时用它算落差
    if (this.flying || this.onGround) this._fallPeak = this.pos.y;
    else if (this.pos.y > this._fallPeak) this._fallPeak = this.pos.y;

    // 水平两轴分开判定
    if (this._moveAxis('x', this.vel.x * dt)) this.vel.x = 0;
    if (this._moveAxis('z', this.vel.z * dt)) this.vel.z = 0;

    // 兜底：掉出世界
    if (this.pos.y < -8) {
      this.pos.set(this.pos.x, 46, this.pos.z);
      this.vel.set(0, 0, 0);
    }

    this.camera.position.copy(this.eyePos);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  // --- 射线拾取（Amanatides & Woo 体素遍历）---

  raycast(maxDist = 7) {
    const o = this.eyePos;
    const d = this.forward;

    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);

    const stepX = d.x > 0 ? 1 : d.x < 0 ? -1 : 0;
    const stepY = d.y > 0 ? 1 : d.y < 0 ? -1 : 0;
    const stepZ = d.z > 0 ? 1 : d.z < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / d.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / d.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / d.z) : Infinity;

    let tMaxX = stepX > 0 ? (x + 1 - o.x) / d.x : stepX < 0 ? (o.x - x) / -d.x : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - o.y) / d.y : stepY < 0 ? (o.y - y) / -d.y : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - o.z) / d.z : stepZ < 0 ? (o.z - z) / -d.z : Infinity;

    let nx = 0, ny = 0, nz = 0;

    for (let i = 0; i < 128; i++) {
      const b = this.world.getBlock(x, y, z);
      const def = window.BLOCK_BY_ID[b];
      if (def && def.solid) {
        return { x, y, z, nx, ny, nz };
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (tMaxX > maxDist) break;
        x += stepX; tMaxX += tDeltaX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > maxDist) break;
        y += stepY; tMaxY += tDeltaY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        if (tMaxZ > maxDist) break;
        z += stepZ; tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }

  // 找一个能站的地面高度（出生用）
  findSpawn(x, z) {
    for (let y = window.SY - 2; y > 0; y--) {
      if (this.world.isSolid(Math.floor(x), y, Math.floor(z))) {
        return y + 1.01;
      }
    }
    return 40;
  }
}

window.Player = Player;
