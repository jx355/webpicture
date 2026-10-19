/**
 * 演示页脚本：保存快照后会被内联进 HTML，断网打开时依然执行。
 * 仅做最简单的状态展示，不依赖任何外部库。
 */
(function () {
  'use strict';

  function markExecuted() {
    var el = document.getElementById('js-status');
    if (el) {
      el.textContent = '脚本已执行（保存后依然有效）';
      el.style.color = '#1f7a33';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markExecuted);
  } else {
    markExecuted();
  }
})();
