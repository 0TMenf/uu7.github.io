(function () {
  'use strict';

  window.addEventListener('naiwa-ready', function () {
    var dialog = document.getElementById('leaderboardDialog');
    document.getElementById('closeLeaderboard').onclick = function () {
      dialog.close();
    };
    document.getElementById('openLeaderboard').onclick = function () {
      var s = {};
      try {
        s = JSON.parse(localStorage.getItem('sunny-run-v4-profile') || '{}') || {};
      } catch (e) {}
      document.getElementById('soloLocalRecords').textContent = '最高距离 ' + (Number(s.best) || 0) + ' 米 · 已跑 ' + (Number(s.runs) || 0) + ' 局 · 金币 ' + (Number(s.coins) || 0);
      dialog.showModal();
    };
  });
})();