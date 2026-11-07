/**
 * 主界面的两处氛围细节：
 *   1. 水桶左上方几颗星星一闪一闪
 *   2. 右侧不定时飘过几片树叶
 *
 * 都是纯 DOM 动画，不占 WebGL，也不影响进游戏后的帧率。
 */

(function () {
  const lobby = document.getElementById('lobby');
  const sparkleBox = document.getElementById('sparkles');
  const leafBox = document.getElementById('leaves');
  if (!lobby || !sparkleBox || !leafBox) return;

  // --- 星星：位置对着背景图里水桶的左上方 ---
  const stars = [
    { x: 0.452, y: 0.258, s: 15, d: 2.4, delay: 0.0 },
    { x: 0.498, y: 0.212, s: 10, d: 3.0, delay: 0.55 },
    { x: 0.531, y: 0.272, s: 8,  d: 2.2, delay: 1.05 },
    { x: 0.437, y: 0.312, s: 7,  d: 2.8, delay: 1.6 },
    { x: 0.565, y: 0.238, s: 9,  d: 3.2, delay: 2.1 },
  ];

  stars.forEach((st) => {
    const el = document.createElement('i');
    el.style.left = (st.x * 100).toFixed(2) + '%';
    el.style.top = (st.y * 100).toFixed(2) + '%';
    el.style.width = st.s + 'px';
    el.style.height = st.s + 'px';
    el.style.animationDuration = st.d + 's';
    el.style.animationDelay = st.delay + 's';
    sparkleBox.appendChild(el);
  });

  // --- 树叶：从右侧飘进来，往左下角落 ---
  let leafTimer = 0;

  function spawnLeaf() {
    if (lobby.classList.contains('hidden')) return;

    const el = document.createElement('i');
    el.className = 'leaf';

    const size = 0.7 + Math.random() * 0.8;
    el.style.left = (86 + Math.random() * 16) + '%';
    el.style.top = (12 + Math.random() * 58) + '%';
    el.style.width = (16 * size).toFixed(1) + 'px';
    el.style.height = (10 * size).toFixed(1) + 'px';
    el.style.animationDuration = (6.5 + Math.random() * 4).toFixed(2) + 's';
    el.style.filter = 'hue-rotate(' + Math.round((Math.random() - 0.5) * 26) + 'deg)';

    leafBox.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function loop() {
    if (lobby.classList.contains('hidden')) {
      leafTimer = setTimeout(loop, 1200);
      return;
    }
    const n = Math.random() > 0.72 ? 2 : 1;
    for (let i = 0; i < n; i++) setTimeout(spawnLeaf, i * 320);
    leafTimer = setTimeout(loop, 2200 + Math.random() * 3200);
  }

  leafTimer = setTimeout(loop, 900);
  window.__stopLeaves = () => clearTimeout(leafTimer);

  // --- 主界面按钮 ---
  const startBtn = document.getElementById('startBtn');
  const nameDialog = document.getElementById('nameDialog');
  const noticeDialog = document.getElementById('noticeDialog');

  document.getElementById('noticeBtn').onclick = () => noticeDialog.classList.remove('hidden');
  document.getElementById('closeNotice').onclick = () => noticeDialog.classList.add('hidden');
  document.getElementById('loginBtn').onclick = () => {
    if (window.__openNameDialog) window.__openNameDialog('设置昵称');
  };

  // 点击背景空处不误触，点开始按钮由 main.js 接管
  startBtn.addEventListener('click', () => {
    if (window.__onStart) window.__onStart();
  });

  window.__hideLobby = () => {
    lobby.classList.add('hidden');
    if (nameDialog) nameDialog.classList.add('hidden');
    if (noticeDialog) noticeDialog.classList.add('hidden');
  };
})();
