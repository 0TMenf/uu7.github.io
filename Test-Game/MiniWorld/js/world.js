/**
 * 体素世界：地形生成 + 区块网格化
 *
 * 地形靠"同一种子 + 同一个噪声函数"在各自浏览器里算出来，
 * 服务器不传地形，只传种子和你改动过的方块，所以握手数据永远是小的。
 */

const SX = 16, SY = 64, SZ = 16;      // 区块尺寸
const SEA_LEVEL = 20;
// 视距（区块）。设置面板会覆盖这个值；?vd=24 可以直接指定（1-32）
const VIEW_RADIUS = (() => {
  const n = parseInt(new URLSearchParams(location.search).get('vd'), 10);
  return (n >= 1 && n <= 32) ? n : 3;
})();

// ---------------------------------------------------------------- 噪声

function hash2(x, z, seed) {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + (seed | 0) * 2246822519;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = smooth(xf), v = smooth(zf);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, z, seed, octaves) {
  let total = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * freq, z * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / norm;
}

// ---------------------------------------------------------------- 区块

class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint16Array(SX * SY * SZ);   // 756 个方块，8 位不够
    this.biome = new Uint8Array(SX * SZ);   // 每列一个群系编号
    this.mesh = null;
    this.dirty = true;
  }

  idx(x, y, z) {
    return (y * SZ + z) * SX + x;
  }

  get(x, y, z) {
    if (x < 0 || x >= SX || y < 0 || y >= SY || z < 0 || z >= SZ) return 0;
    return this.blocks[this.idx(x, y, z)];
  }

  set(x, y, z, v) {
    if (x < 0 || x >= SX || y < 0 || y >= SY || z < 0 || z >= SZ) return;
    this.blocks[this.idx(x, y, z)] = v;
  }
}

// 六个面：dir 是邻格偏移，corners 是四角（含 UV），kind 决定用哪张贴图
const FACES = [
  { kind: 'side', dir: [-1, 0, 0], corners: [
    { pos: [0, 1, 0], uv: [0, 1] }, { pos: [0, 0, 0], uv: [0, 0] },
    { pos: [0, 1, 1], uv: [1, 1] }, { pos: [0, 0, 1], uv: [1, 0] },
  ]},
  { kind: 'side', dir: [1, 0, 0], corners: [
    { pos: [1, 1, 1], uv: [0, 1] }, { pos: [1, 0, 1], uv: [0, 0] },
    { pos: [1, 1, 0], uv: [1, 1] }, { pos: [1, 0, 0], uv: [1, 0] },
  ]},
  { kind: 'bottom', dir: [0, -1, 0], corners: [
    { pos: [1, 0, 1], uv: [1, 0] }, { pos: [0, 0, 1], uv: [0, 0] },
    { pos: [1, 0, 0], uv: [1, 1] }, { pos: [0, 0, 0], uv: [0, 1] },
  ]},
  { kind: 'top', dir: [0, 1, 0], corners: [
    { pos: [0, 1, 1], uv: [1, 1] }, { pos: [1, 1, 1], uv: [0, 1] },
    { pos: [0, 1, 0], uv: [1, 0] }, { pos: [1, 1, 0], uv: [0, 0] },
  ]},
  { kind: 'side', dir: [0, 0, -1], corners: [
    { pos: [1, 0, 0], uv: [0, 0] }, { pos: [0, 0, 0], uv: [1, 0] },
    { pos: [1, 1, 0], uv: [0, 1] }, { pos: [0, 1, 0], uv: [1, 1] },
  ]},
  { kind: 'side', dir: [0, 0, 1], corners: [
    { pos: [0, 0, 1], uv: [0, 0] }, { pos: [1, 0, 1], uv: [1, 0] },
    { pos: [0, 1, 1], uv: [0, 1] }, { pos: [1, 1, 1], uv: [1, 1] },
  ]},
];

// 顶点 AO：看这个角周围被几个方块挡住
const AO_OFFSETS = [
  [[-1, 0, 0], [0, -1, 0], [-1, -1, 0]],
  [[1, 0, 0], [0, -1, 0], [1, -1, 0]],
  [[-1, 0, 0], [0, 1, 0], [-1, 1, 0]],
  [[1, 0, 0], [0, 1, 0], [1, 1, 0]],
];

// 热路径上的查表全部提到模块作用域，避免反复走 window 属性
const _SOLID = window.SOLID;
const _OPAQUE = window.OPAQUE;
const _OVERLAY = window.OVERLAY;
const _TILE_TOP = window.TILE_TOP;
const _GEOM = window.GEOM_OF;   // 方块 id → 几何编号（0 = 立方体）
const _PANE = window.PANE;      // 1 = 玻璃板，按邻居生成薄板
const _OCC = new Uint8Array(9);   // AO 用的 3x3 邻域，复用以避免每次分配

// 图集 UV 参数，全部由 blocks.js 的尺寸推导，改纹理分辨率不用再动这里
const _US = window.TILE / window.ATLAS_SIZE;        // 一格纹理的 UV 跨度
const _P0 = window.ATLAS_PAD / window.ATLAS_SIZE;   // 扩边偏移
const _STEP = window.ATLAS_CELL / window.ATLAS_SIZE; // 相邻格子间距
// UV 向内收半个纹素：正好落在边界时 mipmap 会采样到扩边/邻格，表现为方块间一条细黑线
const _INSET = 0.5 / window.ATLAS_SIZE;
const _US_IN = _US - _INSET * 2;

// 六个面的固定明暗（-X, +X, -Y, +Y, -Z, +Z）。
// 烘焙进顶点色而不是交给方向光：顶面和侧面的亮度关系就固定了，
// 不会出现太阳一低侧面全黑、顶面惨白那种割裂感。
const FACE_SHADE = [0.88, 0.88, 0.66, 1.0, 0.82, 0.82];
const _AO4 = new Float32Array(4);   // 复用的四角 AO

FACES.forEach((f) => {
  f.tiles = f.kind === 'top' ? window.TILE_TOP
    : f.kind === 'bottom' ? window.TILE_BOTTOM
    : window.TILE_SIDE;

  // 面的法线轴确定后，另两个就是切向轴，AO 要用
  const axes = [0, 1, 2].filter((a) => f.dir[a] === 0);
  f.axis1 = axes[0];
  f.axis2 = axes[1];
});

class World {
  constructor(scene, seed, material, biomes) {
    this.scene = scene;
    this.seed = seed;
    this.material = material;
    this.shadows = false;

    // 群系表来自原版 biomedef.csv：草色是每个群系一个固定 hex，
    // 这里换算成"目标色 / 贴图平均色"的乘数，乘完正好落在原版颜色上。
    this.biomes = biomes || [];
    const n = this.biomes.length;
    this.tint = new Float32Array(n * 3);
    this.trees = new Float32Array(n);
    this.topBlock = new Uint8Array(n);
    this.minH = new Float32Array(n);
    this.maxH = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.humid = new Float32Array(n);
    this.water = new Uint8Array(n);

    const BASE = [182, 181, 126];   // grass_top.png 的平均色
    this.biomes.forEach((b, i) => {
      const hex = String(b.grass || '#b9c527').replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const bl = parseInt(hex.slice(4, 6), 16) || 0;
      this.tint[i * 3] = Math.min(1.8, r / BASE[0]);
      this.tint[i * 3 + 1] = Math.min(1.8, g / BASE[1]);
      this.tint[i * 3 + 2] = Math.min(1.8, bl / BASE[2]);
      this.trees[i] = Math.min(0.9, Math.max(0, b.trees || 0) / 1000);
      this.topBlock[i] = b.top || 1;
      this.minH[i] = b.minH;
      this.maxH[i] = b.maxH;
      this.heat[i] = b.heat;
      this.humid[i] = b.humid;
      this.water[i] = b.water ? 1 : 0;
    });
    this.chunks = new Map();          // 数字键 -> Chunk
    this.edits = new Map();           // "x,y,z" -> id，仅作记录
    this.editsByChunk = new Map();    // 数字键 -> [[lx,ly,lz,id], ...]
  }

  // 数字键：字符串键在这个调用量下会产生大量临时对象和 GC 压力
  key(cx, cz) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  // --- 地形 ---

  heightAt(wx, wz) {
    // 三层叠加：大尺度地貌 + 丘陵 + 缓坡细节。
    // 关键是不要加逐格随机（原来那行 jag），那会把地面打成坑坑洼洼的蜂窝。
    // 八度数直接决定单列成本：每多一个八度就多一次 valueNoise（4 次 hash）。
    // 256 列 × 每列 7 个八度 ≈ 7000 次噪声，是区块生成的主要开销，这里压到 5 个。
    const continent = fbm(wx / 320, wz / 320, this.seed, 2);
    const hills = fbm(wx / 55, wz / 55, this.seed + 1013, 2);
    const detail = fbm(wx / 20, wz / 20, this.seed + 2027, 1);

    let h = 12 + continent * 32 + (hills - 0.5) * 14 + (detail - 0.5) * 5;

    // 海平面附近直接往下挖，保证湖至少有 2 格水深。
    // 之前是把地形"压平"到海平面附近，结果造出一大片 19 格平台紧挨着 22 格沙滩，
    // 20、21 格完全不出现 —— 看上去就是一个没有水的沙坑。
    if (h < SEA_LEVEL + 1) {
      h = SEA_LEVEL - ((SEA_LEVEL + 1 - h) * 0.9 + 2);
    }

    return Math.max(1, Math.min(SY - 8, Math.round(h)));
  }

  /**
   * 群系选择：先按高度筛掉不合适的，再在 (温度, 湿度) 里找最近的一个。
   * 高度是归一化值（(h-20)/10），和原版 biomedef 的 MinHeight/MaxHeight 同一套刻度。
   */
  climateAt(wx, wz) {
    const t = fbm(wx / 420, wz / 420, this.seed + 9001, 1);
    const u = fbm(wx / 420, wz / 420, this.seed + 9002, 1);
    return [
      Math.max(0, Math.min(100, ((t - 0.15) / 0.5) * 100)),
      Math.max(0, Math.min(100, ((u - 0.15) / 0.5) * 100)),
    ];
  }

  biomeIndexAt(wx, wz, height) {
    const n = this.biomes.length;
    if (!n) return -1;

    // 归一化高度：海平面以上 1 格算 0，往上 34 格算 1。
    // 尺度太小会把 25 格的丘陵当成高山，整片世界变成"峭壁/红土"。
    const hn = (height - (SEA_LEVEL + 1)) / 34;
    const wet = height < SEA_LEVEL;
    const c = this.climateAt(wx, wz);
    const heat = c[0], humid = c[1];

    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (this.water[i] !== (wet ? 1 : 0)) continue;   // 水下只选水域群系，陆地只选陆地群系
      if (hn < this.minH[i] || hn > this.maxH[i]) continue;
      const dh = heat - this.heat[i];
      const du = humid - this.humid[i];
      const d = dh * dh + du * du;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) return best;

    // 高度超出所有群系（很高的山）时，退化成纯气候匹配
    for (let i = 0; i < n; i++) {
      if (this.water[i] !== (wet ? 1 : 0)) continue;
      const dh = heat - this.heat[i];
      const du = humid - this.humid[i];
      const d = dh * dh + du * du;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  makeChunkData(cx, cz) {
    const chunk = new Chunk(cx, cz);
    const baseX = cx * SX;
    const baseZ = cz * SZ;

    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const wx = baseX + x, wz = baseZ + z;
        const h = this.heightAt(wx, wz);

        const bi = this.biomeIndexAt(wx, wz, h);
        chunk.biome[(z << 4) | x] = bi < 0 ? 0 : bi;

        // 地表方块：先按高度定沙/草，再让群系覆盖（沙漠、沙滩整片是沙）
        let surface = h <= SEA_LEVEL + 1 ? 4 : 1;
        if (h > SEA_LEVEL + 1 && bi >= 0 && this.topBlock[bi] !== 1) {
          surface = this.topBlock[bi];
        }

        for (let y = 0; y <= h; y++) {
          let b;
          if (y === 0) b = 14;                          // 基岩
          else if (y < h - 3) b = 3;                    // 石头
          else if (y < h) b = 2;                        // 泥土
          else b = surface;
          chunk.set(x, y, z, b);
        }

        // 矿洞：每列只算一次噪声判断是否落在"洞穴带"里，命中后挖一段连续竖井。
        // 两条硬约束：
        //   1. 不要按 y 逐层调 fbm —— 那样一个区块上完次噪声，生成时间从 0.2ms 涨到 40ms；
        //   2. 必须是连续的一段，散点挖法看着像空腔，但一格都站不进去。
        if (h > 16) {
          const band = fbm(wx / 22, wz / 22, this.seed + 3300, 2);
          if (band > 0.60) {
            const top = h - 6;
            const span = top - 5;
            if (span > 6) {
              const h0 = 5 + Math.floor(hash2(wx, wz, this.seed + 3311) * (span - 4));
              const len = 4 + Math.floor(hash2(wx, wz, this.seed + 3312) * 9);
              const end = Math.min(top, h0 + len);
              for (let y = h0; y < end; y++) chunk.set(x, y, z, 0);
            }
          }
        }

        // 灌水：从地表上方一直填到海平面
        for (let y = h + 1; y <= SEA_LEVEL; y++) chunk.set(x, y, z, 12);
      }
    }

    // 种树：按世界坐标的 8x8 网格布点，跨区块的树也能画进来
    this.plantTrees(chunk);

    return chunk;
  }

  /**
   * 树的分布不用"逐格随机"，那样一定会出现三棵挤在一起、旁边一大片空地。
   * 改成世界坐标下的 8x8 网格：每格最多一棵，位置在格内小幅抖动，
   * 因此天然满足"均匀 + 有最小间距"，再用低频噪声控制森林/草原的疏密。
   */
  plantTrees(chunk) {
    const baseX = chunk.cx * SX, baseZ = chunk.cz * SZ;
    const CELL = 8;
    const PAD = 3;                    // 树冠半径，跨块的树也要算进来
    const c0x = Math.floor((baseX - PAD) / CELL);
    const c1x = Math.floor((baseX + SX - 1 + PAD) / CELL);
    const c0z = Math.floor((baseZ - PAD) / CELL);
    const c1z = Math.floor((baseZ + SZ - 1 + PAD) / CELL);

    for (let gz = c0z; gz <= c1z; gz++) {
      for (let gx = c0x; gx <= c1x; gx++) {
        const jx = hash2(gx, gz, this.seed + 7001);
        const jz = hash2(gx, gz, this.seed + 7002);
        const tx = gx * CELL + 2 + Math.floor(jx * (CELL - 4));
        const tz = gz * CELL + 2 + Math.floor(jz * (CELL - 4));

        const h = this.heightAt(tx, tz);
        if (h <= SEA_LEVEL + 2) continue;        // 水下和沙滩不长树

        // 树的密度直接取原版 biomedef 的 ChunkTrees（千分比）：
        // 森林 600 → 每个 8x8 格 60%，丛林 1000 → 满，草原 1 → 基本没有
        const bi = this.biomeIndexAt(tx, tz, h);
        const p = bi >= 0 ? this.trees[bi] : 0.15;
        if (p <= 0) continue;
        if (hash2(gx, gz, this.seed + 7003) > p) continue;

        const trunk = 4 + Math.floor(hash2(gx, gz, this.seed + 7004) * 3);
        if (h + trunk + 3 >= SY) continue;

        this.writeTree(chunk, tx, h, tz, trunk, baseX, baseZ);
      }
    }
  }

  writeTree(chunk, tx, h, tz, trunk, baseX, baseZ) {
    const place = (wx, wy, wz, id, onlyAir) => {
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx < 0 || lx >= SX || lz < 0 || lz >= SZ) return;   // 落在其它区块的部分由那块自己画
      if (wy < 2 || wy >= SY - 1) return;
      const i = (wy << 8) | (lz << 4) | lx;
      if (onlyAir && chunk.blocks[i] !== 0) return;
      chunk.blocks[i] = id;
    };

    for (let i = 1; i <= trunk; i++) place(tx, h + i, tz, 5, false);

    // 树冠：两层 5x5 削角 + 顶层 3x3，和原版的方块树比例接近
    for (let dy = -2; dy <= 1; dy++) {
      const r = dy >= 1 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue;   // 四角切掉，不出现方块疙瘩
          const salt = this.seed + dy * 31;
          if (hash2(tx + dx, tz + dz, salt) > 0.82) continue;       // 随机缺口，树冠更自然
          place(tx + dx, h + trunk + dy, tz + dz, 6, true);
        }
      }
    }
    place(tx, h + trunk + 2, tz, 6, true);
  }

  ensureChunk(cx, cz) {
    const k = this.key(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = this.makeChunkData(cx, cz);
      // 把这个区块上已知的改动直接焊进数据，之后读方块就不用再查 edits
      const pending = this.editsByChunk.get(k);
      if (pending) {
        for (let i = 0; i < pending.length; i++) {
          const e = pending[i];
          c.set(e[0], e[1], e[2], e[3]);
        }
      }
      c.dirty = true;
      this.chunks.set(k, c);
    }
    return c;
  }

  // --- 读写方块（世界坐标）---

  getBlock(x, y, z) {
    if (y < 0 || y >= SY) return 0;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get((cx + 32768) * 65536 + (cz + 32768));
    if (!c) return 0;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  isSolid(x, y, z) {
    return _SOLID[this.getBlock(x, y, z)] === 1;
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= SY) return;

    const cx = x >> 4, cz = z >> 4;
    const ck = this.key(cx, cz);
    const c = this.chunks.get(ck);
    const lx = x & 15, lz = z & 15;

    if (c) {
      c.set(lx, y, lz, id);
      c.dirty = true;

      // 改到边界时邻居也要重建，否则接缝处会留洞
      if (lx === 0) this.markDirty(cx - 1, cz);
      if (lx === 15) this.markDirty(cx + 1, cz);
      if (lz === 0) this.markDirty(cx, cz - 1);
      if (lz === 15) this.markDirty(cx, cz + 1);
      return;
    }

    // 区块还没生成：先记下，等它生成时再焊进去
    this.edits.set(x + ',' + y + ',' + z, id);
    let arr = this.editsByChunk.get(ck);
    if (!arr) { arr = []; this.editsByChunk.set(ck, arr); }
    arr.push([lx, y, lz, id]);
  }

  // 切换材质（流畅档用不受光材质，均衡/精细用能接收阴影的 Lambert）
  setMaterial(mat) {
    if (!mat || this.material === mat) return;
    this.material = mat;
    for (const c of this.chunks.values()) {
      if (c.mesh) c.mesh.material = mat;
    }
  }

  // 阴影开关：只动已经建好的网格，新建的网格会读 this.shadows
  setShadows(on) {
    this.shadows = !!on;
    for (const c of this.chunks.values()) {
      if (!c.mesh) continue;
      c.mesh.castShadow = this.shadows;
      c.mesh.receiveShadow = this.shadows;
    }
  }

  markDirty(cx, cz) {
    const c = this.chunks.get(this.key(cx, cz));
    if (c) c.dirty = true;
  }

  // --- 网格化 ---

  buildGeometry(chunk) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const colors = [];
    const indices = [];
    let vi = 0;

    const baseX = chunk.cx * SX;
    const baseZ = chunk.cz * SZ;
    const blocks = chunk.blocks;
    // 只有真的加载到原版覆盖层贴图时才画草边，否则侧面的草会变成一片纯色
    const HAS_OVERLAY = window.HAS_OVERLAY !== false;

    // 热路径：绝大多数邻居都在本区块内，直接走数组下标，
    // 只有跨边界那一圈才回落到 getBlock 查 Map。
    const self = this;
    const blockAt = (nx, ny, nz) => {
      if (ny < 0 || ny >= SY) return 0;
      const lx = nx - baseX, lz = nz - baseZ;
      if (lx >= 0 && lx < SX && lz >= 0 && lz < SZ) {
        return blocks[(ny << 8) | (lz << 4) | lx];
      }
      return self.getBlock(nx, ny, nz);
    };
    const solidAt = (nx, ny, nz) => _SOLID[blockAt(nx, ny, nz)];

    // 模型方块：把 OBJ 的三角面平移到方块位置，UV 映射到它自己的图集格。
    // 顶点按三角展开（不共享），因为每个面法线不同 —— 模型方块数量少，不值得为省顶点做索引复用。
    // 通用的长方体：复用 FACES 的六个面和 UV，用来拼玻璃板这类程序几何
    const emitBox = (x0, y0, z0, x1, y1, z1, wx, wy, wz, tile, baseVi, coef) => {
      const u0 = (tile & 31) * _STEP + _P0;
      const v0 = (tile >> 5) * _STEP + _P0;
      let vi2 = baseVi;

      for (let fi = 0; fi < 6; fi++) {
        const face = FACES[fi];
        const sh = FACE_SHADE[fi] * coef;
        for (let ci = 0; ci < 4; ci++) {
          const c = face.corners[ci];
          positions.push(
            wx + (c.pos[0] ? x1 : x0),
            wy + (c.pos[1] ? y1 : y0),
            wz + (c.pos[2] ? z1 : z0)
          );
          normals.push(face.dir[0], face.dir[1], face.dir[2]);
          uvs.push(
            u0 + _INSET + c.uv[0] * _US_IN,
            1 - (v0 + _INSET + (1 - c.uv[1]) * _US_IN)
          );
          colors.push(sh, sh, sh);
        }
        indices.push(vi2, vi2 + 1, vi2 + 2, vi2 + 2, vi2 + 1, vi2 + 3);
        vi2 += 4;
      }
      return vi2;
    };

    // 玻璃板：中心细柱 + 四个方向按邻居伸出的薄板。
    // 判定规则和原版一致——相邻是玻璃板或实心方块就连过去。
    const emitPane = (id, wx, y, wz, baseVi) => {
      const tile = _TILE_TOP[id];
      const T = 0.0625;          // 板厚的一半（整片 0.125 格）
      const C = 0.5;             // 伸出到方块边缘
      let vi2 = baseVi;

      const link = (dx, dz) => {
        const nb = blockAt(wx + dx, y, wz + dz);
        if (!nb) return false;
        return _PANE[nb] === 1 || _OPAQUE[nb] === 1;
      };

      const east = link(1, 0), west = link(-1, 0);
      const south = link(0, 1), north = link(0, -1);

      // 一根都没有就按直板处理，免得孤立玻璃板变成小方块
      const anyLink = east || west || south || north;
      const xAxis = east || west || !anyLink;
      const zAxis = south || north || !anyLink;

      // 中心柱
      vi2 = emitBox(-T, 0, -T, T, 1, T, wx, y, wz, tile, vi2, 0.94);

      if (xAxis) {
        if (east) vi2 = emitBox(T, 0, -T, C, 1, T, wx, y, wz, tile, vi2, 1);
        if (west) vi2 = emitBox(-C, 0, -T, -T, 1, T, wx, y, wz, tile, vi2, 1);
      }
      if (zAxis) {
        if (south) vi2 = emitBox(-T, 0, T, T, 1, C, wx, y, wz, tile, vi2, 1);
        if (north) vi2 = emitBox(-T, 0, -C, T, 1, -T, wx, y, wz, tile, vi2, 1);
      }
      return vi2;
    };

    const geomList = this.geom || window.GEOM_LIST;
    const emitModel = (id, gi, wx, y, wz, baseVi) => {
      const g = geomList && geomList[gi - 1];
      if (!g) return baseVi;

      const tile = _TILE_TOP[id];
      const u0 = (tile & 31) * _STEP + _P0;
      const v0 = (tile >> 5) * _STEP + _P0;
      const P = g.pos, U = g.uv, I = g.idx;
      let vi2 = baseVi;

      for (let t = 0; t < I.length; t += 3) {
        const ia = I[t], ib = I[t + 1], ic = I[t + 2];
        const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
        const bx = P[ib * 3], by = P[ib * 3 + 1], bz = P[ib * 3 + 2];
        const cx = P[ic * 3], cy = P[ic * 3 + 1], cz = P[ic * 3 + 2];

        // 面法线（叉积）
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len; ny /= len; nz /= len;

        // 朝上的面最亮，朝下最暗，侧面居中
        const shade = 0.68 + 0.32 * Math.max(0, ny) * 1.0 - 0.12 * Math.max(0, -ny);

        // 正反各画一次：原版 OBJ 里不同面的绕序并不统一，
        // 只画正面会让一部分面被背面剔除掉，看着就是"碎成一堆尖片"。
        for (let side = 0; side < 2; side++) {
          const flip = side === 1;
          const sgn = flip ? -1 : 1;
          const sh = flip ? shade * 0.82 : shade;

          for (let k = 0; k < 3; k++) {
            const i = flip
              ? (k === 0 ? ia : (k === 1 ? ic : ib))
              : (k === 0 ? ia : (k === 1 ? ib : ic));
            positions.push(wx + P[i * 3], y + P[i * 3 + 1], wz + P[i * 3 + 2]);
            normals.push(nx * sgn, ny * sgn, nz * sgn);
            uvs.push(
              u0 + _INSET + U[i * 2] * _US_IN,
              1 - (v0 + _INSET + (1 - U[i * 2 + 1]) * _US_IN)
            );
            colors.push(sh, sh, sh);
          }
          indices.push(vi2, vi2 + 1, vi2 + 2);
          vi2 += 3;
        }
      }
      return vi2;
    };

    // 先找最高非空层，上面整层空气不必遍历
    let maxY = SY - 1;
    for (; maxY > 0; maxY--) {
      const base = maxY << 8;
      let any = false;
      for (let i = 0; i < 256; i++) {
        if (blocks[base + i]) { any = true; break; }
      }
      if (any) break;
    }

    for (let y = 0; y <= maxY; y++) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          const id = blocks[(y << 8) | (z << 4) | x];
          if (!id) continue;

          const wx = baseX + x, wz = baseZ + z;

          // 玻璃板：几何按四周邻居现算，不能预烘焙
          if (_PANE[id]) {
            vi = emitPane(id, wx, y, wz, vi);
            continue;
          }

          // 有模型的方块走另一条路径，不参与面剔除和 AO
          const gi = _GEOM[id];
          if (gi) {
            vi = emitModel(id, gi, wx, y, wz, vi);
            continue;
          }

          // 草色直接查群系表（原版 biomedef 的 GrassColor），
          // 乘数已经算成"目标色 / 贴图平均色"，乘上去就是那个群系的草色。
          let tintR = 0.52, tintG = 0.94, tintB = 0.42;   // 群系表缺失时的兜底绿
          if (id === 1) {
            const bi = chunk.biome[(z << 4) | x];
            if (bi < this.biomes.length) {
              tintR = this.tint[bi * 3];
              tintG = this.tint[bi * 3 + 1];
              tintB = this.tint[bi * 3 + 2];
            }
          }

          for (let fi = 0; fi < 6; fi++) {
            const face = FACES[fi];
            const bx = wx + face.dir[0];
            const by = y + face.dir[1];
            const bz = wz + face.dir[2];

            const nb = blockAt(bx, by, bz);
            if (nb === id) continue;
            if (_OPAQUE[nb] === 1) continue;

            const tile = face.tiles[id];
            const u0 = (tile & 31) * _STEP + _P0;
            const v0 = (tile >> 5) * _STEP + _P0;
            const sh = FACE_SHADE[fi];

            const a1 = face.axis1, a2 = face.axis2;

            // AO 用到的其实是面外侧平面上的 3x3 邻居，一次算 8 个，
            // 比四个顶点各查三次省掉三分之一的 getBlock 调用。
            _OCC.fill(0);
            for (let a = 0; a < 9; a++) {
              if (a === 4) continue;
              const s1 = (a % 3) - 1;
              const s2 = ((a / 3) | 0) - 1;
              let px = bx, py = by, pz = bz;
              if (a1 === 0) px += s1; else if (a1 === 1) py += s1; else pz += s1;
              if (a2 === 0) px += s2; else if (a2 === 1) py += s2; else pz += s2;
              _OCC[a] = solidAt(px, py, pz);
            }

            // 四角 AO 先算出来，基面和草边覆盖层共用
            for (let ci = 0; ci < 4; ci++) {
              const c = face.corners[ci];
              const s1 = c.pos[a1] ? 1 : -1;
              const s2 = c.pos[a2] ? 1 : -1;
              const o = _OCC[(s1 + 1) + (s2 + 1) * 3]
                      + _OCC[(s1 + 1) + 1 * 3]
                      + _OCC[1 + (s2 + 1) * 3];
              _AO4[ci] = 1 - (o > 3 ? 3 : o) * 0.17;
            }

            const tinted = (id === 1 && face.kind === 'top');

            for (let ci = 0; ci < 4; ci++) {
              const c = face.corners[ci];
              positions.push(wx + c.pos[0], y + c.pos[1], wz + c.pos[2]);
              normals.push(face.dir[0], face.dir[1], face.dir[2]);

              uvs.push(
                u0 + _INSET + c.uv[0] * _US_IN,
                1 - (v0 + _INSET + (1 - c.uv[1]) * _US_IN)
              );

              const k = _AO4[ci] * sh;
              if (tinted) colors.push(k * tintR, k * tintG, k * tintB);
              else colors.push(k, k, k);
            }

            indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3);
            vi += 4;

            // 草方块侧面再叠一层带 alpha 的草边：它和顶面用的是同一套像素，
            // 乘同一个群系着色，所以顶面侧面的草色才会真正统一。
            const ot = _OVERLAY[id];
            if (ot >= 0 && face.kind === 'side' && HAS_OVERLAY) {
              const ou = (ot & 31) * _STEP + _P0;
              const ov = (ot >> 5) * _STEP + _P0;
              const ox = face.dir[0] * 0.004;
              const oy = face.dir[1] * 0.004;
              const oz = face.dir[2] * 0.004;

              for (let ci = 0; ci < 4; ci++) {
                const c = face.corners[ci];
                positions.push(wx + c.pos[0] + ox, y + c.pos[1] + oy, wz + c.pos[2] + oz);
                normals.push(face.dir[0], face.dir[1], face.dir[2]);
                uvs.push(
                  ou + _INSET + c.uv[0] * _US_IN,
                  1 - (ov + _INSET + (1 - c.uv[1]) * _US_IN)
                );
                const k = _AO4[ci] * sh;
                colors.push(k * tintR, k * tintG, k * tintB);
              }

              indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3);
              vi += 4;
            }
          }
        }
      }
    }

    if (!vi) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  rebuildChunk(chunk) {
    // 边界处的邻块数据必须先就位，否则会算错面
    this.ensureChunk(chunk.cx - 1, chunk.cz);
    this.ensureChunk(chunk.cx + 1, chunk.cz);
    this.ensureChunk(chunk.cx, chunk.cz - 1);
    this.ensureChunk(chunk.cx, chunk.cz + 1);

    const geo = this.buildGeometry(chunk);

    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      chunk.mesh = null;
    }

    if (geo) {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.frustumCulled = true;
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      this.scene.add(mesh);
      chunk.mesh = mesh;
    }
    chunk.dirty = false;
  }
}

window.World = World;
window.SX = SX;
window.SY = SY;
window.SZ = SZ;
window.SEA_LEVEL = SEA_LEVEL;
window.VIEW_RADIUS = VIEW_RADIUS;
