/**
 * 音效：原版 ogg 采样 + 合成音兜底
 *
 * 方块音效来自客户端 assets/sounds/：
 *   blocks/stone1.ogg … 走路 / 放置
 *   blockd/stone1.ogg … 挖掘
 * blockdef.csv 里每个方块都记着用哪个类别（stone / wood / grass / cloth …），
 * 所以挖什么方块就响什么声音，不用手写映射。
 *
 * 没加载到就用 WebAudio 现场合成的噪声顶上，保证不会静音。
 */

(function () {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let volume = 0.7;
  let lastDig = 0;

  const buffers = Object.create(null);   // 'blockd/stone' -> [AudioBuffer, ...]
  let manifest = null;
  let loading = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);

    // 半秒白噪声，合成音兜底用
    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    return ctx;
  }

  async function decode(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      return await ctx.decodeAudioData(buf);
    } catch {
      return null;
    }
  }

  // 78 个小文件，分批并发，避免一次打太多请求
  function loadAll() {
    if (loading) return loading;
    loading = (async () => {
      if (!ensure()) return;
      try {
        manifest = await fetch('./data/sounds.json').then((r) => r.json());
      } catch {
        return;
      }

      const jobs = [];
      for (const kind of ['blocks', 'blockd']) {
        for (const cat of Object.keys(manifest[kind] || {})) {
          const n = manifest[kind][cat];
          for (let i = 1; i <= n; i++) {
            jobs.push({ key: kind + '/' + cat, url: './sounds/' + kind + '/' + cat + i + '.ogg' });
          }
        }
      }

      const BATCH = 12;
      for (let i = 0; i < jobs.length; i += BATCH) {
        const slice = jobs.slice(i, i + BATCH);
        const got = await Promise.all(slice.map((j) => decode(j.url)));
        got.forEach((buf, k) => {
          if (!buf) return;
          const key = slice[k].key;
          (buffers[key] || (buffers[key] = [])).push(buf);
        });
      }

      const total = Object.values(buffers).reduce((a, b) => a + b.length, 0);
      console.log('[音效] 载入 ' + total + ' 个原版采样，'
        + Object.keys(buffers).length + ' 个类别');
    })();
    return loading;
  }

  function play(kind, cat, gain) {
    if (!cat) return false;
    if (!ensure()) return false;
    if (ctx.state === 'suspended') ctx.resume();

    const list = buffers[kind + '/' + cat];
    if (!list || !list.length) return false;

    const src = ctx.createBufferSource();
    src.buffer = list[(Math.random() * list.length) | 0];

    const g = ctx.createGain();
    g.gain.value = gain === undefined ? 1 : gain;

    // 轻微随机音高，连续挖同一块不会像复读机
    src.playbackRate.value = 0.92 + Math.random() * 0.16;

    src.connect(g);
    g.connect(master);
    src.start();
    return true;
  }

  function noise(dur, freq, gain) {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();

    f.type = 'bandpass';
    f.frequency.value = freq;

    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);

    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start();
    src.stop(ctx.currentTime + dur);
  }

  window.SFX = {
    unlock() {
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume();
      loadAll();
    },

    ready() { return loadAll(); },

    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },

    getVolume() { return volume; },

    /** 挖掘：优先用原版采样，类别来自方块表的 blockd.* */
    dig(cat) {
      const now = performance.now();
      if (now - lastDig < 220) return;      // 连续挖掘时别糊成一片噪音
      lastDig = now;
      if (play('blockd', cat, 0.6)) return;
      noise(0.09, 900, 0.12);
    },

    /** 放置 / 走路：原版 blocks.* */
    place(cat) {
      if (play('blocks', cat, 0.55)) return;
      noise(0.06, 420, 0.16);
    },

    step(cat) {
      if (play('blocks', cat, 0.3)) return;
    },

    /** 破坏完成：一声更实的闷响 */
    breakBlock(cat) {
      if (play('blockd', cat, 0.85)) return;
      noise(0.16, 600, 0.2);
    }
  };
})();
