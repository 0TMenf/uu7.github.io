/**
 * 昼夜循环
 *
 * 对齐原版的 World.getHours / setHours / isDaytime：
 * 一天走完真实 20 分钟，光照、天空、雾色都按关键帧插值。
 */

const DAY_LENGTH = 1200;      // 真实秒数 = 一个完整昼夜（20 分钟，和原版一个白天相近）
const SUN_RADIUS = 150;

// 时间关键帧：h 小时 → 天空色 / 雾色 / 阳光强度 / 阳光色 / 环境光强度
// 注意 light + hemi 是相加的，白天合计要压在 1.0 附近，否则方块颜色会过曝发白
const SKY_KEYS = [
  { h: 0.0,  sky: 0x070b18, fog: 0x070b18, light: 0.06, color: 0x6a7cb8, hemi: 0.14 },
  { h: 4.5,  sky: 0x0d1428, fog: 0x0d1428, light: 0.07, color: 0x6a7cb8, hemi: 0.15 },
  { h: 6.0,  sky: 0x3a3f66, fog: 0x4a4a72, light: 0.15, color: 0xffa070, hemi: 0.22 },
  { h: 6.5,  sky: 0x8d6460, fog: 0x9d7975, light: 0.25, color: 0xffa878, hemi: 0.28 },
  { h: 7.0,  sky: 0xe08a5a, fog: 0xf0a878, light: 0.38, color: 0xffb080, hemi: 0.34 },
  { h: 8.5,  sky: 0x9FDBF3, fog: 0xBFE9F7, light: 0.56, color: 0xfff4e0, hemi: 0.42 },
  { h: 12.0, sky: 0x8ecff0, fog: 0xbfe9f7, light: 0.60, color: 0xffffff, hemi: 0.45 },
  { h: 16.0, sky: 0x9dd6ef, fog: 0xc6e9f6, light: 0.56, color: 0xfff0d8, hemi: 0.42 },
  { h: 18.0, sky: 0xe89a68, fog: 0xf2b184, light: 0.36, color: 0xff9a60, hemi: 0.33 },
  { h: 19.2, sky: 0x4a3a5e, fog: 0x5a4568, light: 0.18, color: 0xd07090, hemi: 0.23 },
  { h: 20.5, sky: 0x141a30, fog: 0x141a30, light: 0.08, color: 0x8090c0, hemi: 0.16 },
  { h: 24.0, sky: 0x070b18, fog: 0x070b18, light: 0.06, color: 0x6a7cb8, hemi: 0.14 },
];

class DayCycle {
  constructor(scene, sun, hemi, fog, blockMat) {
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.fog = fog;
    this.blockMat = blockMat || null;

    this.hours = 8;
    this.speed = 24 / DAY_LENGTH;   // 每小时对应的真实秒数倒数
    this.enabled = true;

    // 阴影模式：环境光拉平，方向光只负责投影（否则侧面会被压得太黑）
    this.shadowMode = false;
    this._dirX = 0; this._dirY = 1; this._dirZ = 0;
    scene.add(sun.target);          // 方向光的目标要进场景，矩阵才会更新

    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();
    this._t1 = new THREE.Color();
    this._t2 = new THREE.Color();
    this._sky = new THREE.Color();
    this._fogC = new THREE.Color();
    this._sunC = new THREE.Color();
    this._tint = new THREE.Color();
    this._white = new THREE.Color(0xffffff);

    this.stars = this._buildStars();
    scene.add(this.stars);

    this.apply();
  }

  _buildStars() {
    const N = 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.92);
      const r = SUN_RADIUS * 1.6;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xdbe8ff,
      size: 1.7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    return pts;
  }

  // 星空球默认半径 240，视距拉到 16 以上时会被裁掉或穿进地形里，
  // 所以按远裁剪面重新缩放，让星星永远在"地形之外、裁剪面之内"。
  setStarRadius(r) {
    this.stars.scale.setScalar(Math.max(0.2, r / (SUN_RADIUS * 1.6)));
  }

  setShadowMode(on, size) {
    on = !!on;
    if (this.shadowMode !== on) {
      this.shadowMode = on;
      this.sun.castShadow = on;
    }
    if (on && size && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;      // 强制按新尺寸重建
      }
    }
    this.apply();
  }

  setHours(h) {
    this.hours = ((h % 24) + 24) % 24;
    this.apply();
  }

  get isDaytime() {
    return this.hours >= 6 && this.hours < 18.5;
  }

  update(dt, playerPos) {
    if (this.enabled) {
      this.hours += dt * this.speed;
      if (this.hours >= 24) this.hours -= 24;
    }
    this.apply();

    if (playerPos) {
      this.stars.position.set(playerPos.x, playerPos.y, playerPos.z);

      // 阴影相机必须跟着玩家，否则只有原点附近有阴影
      if (this.shadowMode) {
        this.sun.position.set(
          playerPos.x + this._dirX * 120,
          playerPos.y + this._dirY * 120,
          playerPos.z + this._dirZ * 120
        );
        this.sun.target.position.set(playerPos.x, playerPos.y, playerPos.z);
      }
    }
  }

  _sample(h) {
    let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
    for (let i = 0; i < SKY_KEYS.length - 1; i++) {
      if (h >= SKY_KEYS[i].h && h <= SKY_KEYS[i + 1].h) {
        a = SKY_KEYS[i];
        b = SKY_KEYS[i + 1];
        break;
      }
    }
    const span = b.h - a.h || 1;
    const t = Math.max(0, Math.min(1, (h - a.h) / span));

    // 结果写进固定对象，避免每帧 new Color 造成 GC 抖动
    this._t1.setHex(a.sky); this._t2.setHex(b.sky);
    this._sky.copy(this._t1).lerp(this._t2, t);

    this._t1.setHex(a.fog); this._t2.setHex(b.fog);
    this._fogC.copy(this._t1).lerp(this._t2, t);

    this._t1.setHex(a.color); this._t2.setHex(b.color);
    this._sunC.copy(this._t1).lerp(this._t2, t);

    return {
      sky: this._sky,
      fog: this._fogC,
      color: this._sunC,
      light: a.light + (b.light - a.light) * t,
      hemi: a.hemi + (b.hemi - a.hemi) * t,
    };
  }

  apply() {
    const s = this._sample(this.hours);

    if (this.scene.background && this.scene.background.copy) {
      this.scene.background.copy(s.sky);
    } else {
      this.scene.background = s.sky.clone();
    }
    if (this.fog) this.fog.color.copy(s.fog);

    this.sun.color.copy(s.color);

    // 太阳方向（单位向量）：夜里压到地平线以上充当月光，避免照亮方块底面
    const ang = ((this.hours - 6) / 24) * Math.PI * 2;
    const dy = Math.max(Math.sin(ang), 0.22);
    const dx = Math.cos(ang);
    const dz = 0.18;
    const len = Math.hypot(dx, dy, dz) || 1;
    this._dirX = dx / len;
    this._dirY = dy / len;
    this._dirZ = dz / len;

    if (this.shadowMode) {
      // 阴影模式：环境光给足，方向光只做投影，侧面不会被压黑
      this.sun.intensity = s.light * 0.5;
      this.hemi.intensity = 0.10 + s.light * 1.05;
      this.hemi.color.setHex(0xffffff);
      this.hemi.groundColor.setHex(0xffffff);
    } else {
      this.sun.intensity = s.light;
      if (this.hemi) {
        this.hemi.color.setHex(0xE4F6FF);
        this.hemi.intensity = s.hemi;
        // 夜间把地面反光压冷，避免整片发绿
        const nightT = Math.max(0, Math.min(1, (0.5 - s.light) / 0.4));
        this._c1.setHex(0x6B8F5A);
        this._c2.setHex(0x2A3048);
        this.hemi.groundColor.copy(this._c1.lerp(this._c2, nightT));
      }
    }

    this.sun.position.set(
      this._dirX * SUN_RADIUS,
      this._dirY * SUN_RADIUS,
      this._dirZ * SUN_RADIUS
    );

    // 方块用顶点色烘焙了面明暗和 AO，材质本身不再吃灯光。
    // 这里给它一个随时间变化的整体色调：正午纯白，黄昏偏暖，夜里压到 0.28。
    if (this.blockMat && !this.shadowMode) {
      const k = 0.20 + Math.min(1, s.light / 0.6) * 0.82;    // 0.28（夜）→ 1.02（正午）
      this._tint.copy(s.color).lerp(this._white, 0.72).multiplyScalar(Math.min(k, 1));
      this.blockMat.color.copy(this._tint);
    }

    // 星星只在夜里出现
    const starT = Math.max(0, Math.min(1, (0.35 - s.light) / 0.25));
    this.stars.material.opacity = starT * 0.9;
    this.stars.visible = starT > 0.01;
  }

  get clockText() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
}

window.DayCycle = DayCycle;
window.DAY_LENGTH = DAY_LENGTH;
