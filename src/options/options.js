/**
 * @file src/options/options.js
 * @description 快照库（options 页）逻辑：
 *              1. 设置表单：读写 chrome.storage.local.settings，change 即保存；
 *              2. 快照库表格：历史列表 + 搜索 + 打开所在文件夹 / 重新保存 / 删除；
 *              3. 导出索引为 JSON、清空历史；
 *              4. 监听 storage.onChanged，多标签页打开时自动刷新。
 */
(function () {
  'use strict';

  /** 设置项与表单控件的映射（key -> 控件 id，含值解析方式） */
  var SETTING_CONTROLS = [
    { key: 'format', id: 'set-format', type: 'value' },
    { key: 'subdir', id: 'set-subdir', type: 'value' },
    { key: 'maxAssetMB', id: 'set-max-asset', type: 'number' },
    { key: 'banner', id: 'set-banner', type: 'checked' },
    { key: 'injectBase', id: 'set-base', type: 'checked' },
    { key: 'askLocation', id: 'set-ask', type: 'checked' },
    { key: 'recordHistory', id: 'set-history', type: 'checked' }
  ];

  var dom = {
    tabs: document.querySelectorAll('.ws-tab'),
    tabLibrary: document.getElementById('tab-library'),
    tabSettings: document.getElementById('tab-settings'),
    searchInput: document.getElementById('search-input'),
    exportBtn: document.getElementById('export-btn'),
    clearBtn: document.getElementById('clear-btn'),
    historyBody: document.getElementById('history-body'),
    emptyTip: document.getElementById('empty-tip')
  };

  /** 全部历史记录（搜索时在内存中过滤） */
  var allHistory = [];

  document.addEventListener('DOMContentLoaded', init);

  /** 初始化入口。 */
  async function init() {
    bindTabs();
    bindSettingsForm();
    bindToolbar();
    await Promise.all([loadSettings(), loadHistory()]);
    // 多标签页同步：storage 变化时自动刷新
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.history) renderHistory(changes.history.newValue || []);
      if (changes.settings) fillSettingsForm(changes.settings.newValue || {});
    });
  }

  /* ================================================================== */
  /* 页签                                                                 */
  /* ================================================================== */

  function bindTabs() {
    dom.tabs.forEach(function (tabBtn) {
      tabBtn.addEventListener('click', function () {
        dom.tabs.forEach(function (b) { b.classList.remove('active'); });
        tabBtn.classList.add('active');
        var name = tabBtn.getAttribute('data-tab');
        dom.tabLibrary.hidden = name !== 'library';
        dom.tabSettings.hidden = name !== 'settings';
      });
    });
  }

  /* ================================================================== */
  /* 设置表单                                                             */
  /* ================================================================== */

  /** 读取设置并回填表单。 */
  function loadSettings() {
    return chrome.storage.local.get('settings').then(function (data) {
      fillSettingsForm(data.settings || {});
    });
  }

  /** 把设置对象写入表单控件。 */
  function fillSettingsForm(settings) {
    SETTING_CONTROLS.forEach(function (ctrl) {
      var el = document.getElementById(ctrl.id);
      if (!el) return;
      var value = settings[ctrl.key];
      if (ctrl.type === 'checked') el.checked = value !== false;
      else if (value != null) el.value = value;
    });
  }

  /** 绑定表单：任何变更立即写回 storage。 */
  function bindSettingsForm() {
    SETTING_CONTROLS.forEach(function (ctrl) {
      var el = document.getElementById(ctrl.id);
      if (!el) return;
      el.addEventListener('change', function () {
        var patch = {};
        patch[ctrl.key] = ctrl.type === 'checked' ? el.checked : el.value;
        chrome.storage.local.get('settings', function (data) {
          var merged = Object.assign({}, data.settings || {}, patch);
          chrome.storage.local.set({ settings: merged });
        });
      });
    });
  }

  /* ================================================================== */
  /* 快照库表格                                                           */
  /* ================================================================== */

  /** 读取历史记录并渲染。 */
  function loadHistory() {
    return chrome.storage.local.get('history').then(function (data) {
      allHistory = data.history || [];
      renderHistory(allHistory);
    });
  }

  /**
   * 渲染历史表格（支持关键字过滤）。
   * @param {Array} history 历史记录数组
   */
  function renderHistory(history) {
    allHistory = history || [];
    var keyword = (dom.searchInput.value || '').trim().toLowerCase();
    var list = keyword
      ? allHistory.filter(function (h) {
          return String(h.title || '').toLowerCase().indexOf(keyword) >= 0 ||
            String(h.url || '').toLowerCase().indexOf(keyword) >= 0;
        })
      : allHistory;

    dom.historyBody.innerHTML = '';
    dom.emptyTip.hidden = list.length > 0;
    if (list.length === 0) return;

    list.forEach(function (item) {
      dom.historyBody.appendChild(buildRow(item));
    });
  }

  /**
   * 构建一行历史记录。
   * @param {Object} item 历史条目
   * @returns {HTMLTableRowElement}
   */
  function buildRow(item) {
    var tr = document.createElement('tr');

    // 保存时间
    var tdTime = document.createElement('td');
    tdTime.textContent = formatTime(item.savedAt);

    // 标题 / 网址
    var tdTitle = document.createElement('td');
    var divTitle = document.createElement('div');
    divTitle.className = 'ws-cell-title';
    divTitle.textContent = item.title || '(无标题)';
    divTitle.title = item.title || '';
    var divUrl = document.createElement('div');
    divUrl.className = 'ws-cell-url';
    divUrl.textContent = item.url || '';
    divUrl.title = item.url || '';
    tdTitle.appendChild(divTitle);
    tdTitle.appendChild(divUrl);

    // 格式
    var tdFormat = document.createElement('td');
    var badge = document.createElement('span');
    badge.className = 'ws-badge ' + (item.format === 'mhtml' ? 'mhtml' : 'html');
    badge.textContent = item.format === 'mhtml' ? 'MHTML' : 'HTML';
    tdFormat.appendChild(badge);

    // 大小
    var tdSize = document.createElement('td');
    tdSize.textContent = item.bytes ? formatBytes(item.bytes) : '—';

    // 状态
    var tdStatus = document.createElement('td');
    if (item.status === 'failed') {
      var fail = document.createElement('span');
      fail.className = 'ws-badge failed';
      fail.textContent = '失败';
      fail.title = item.error || '';
      tdStatus.appendChild(fail);
    } else {
      tdStatus.textContent = '成功';
    }

    // 操作
    var tdActions = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'ws-actions';

    if (item.status !== 'failed') {
      actions.appendChild(buildAction('打开文件夹', function () {
        sendMessage({ type: 'OPEN_DOWNLOAD', downloadId: item.downloadId, filename: item.filename });
      }));
      actions.appendChild(buildAction('重新保存', function () {
        if (confirm('将打开原网页并重新保存快照，当前标签页会被导航到：\n' + item.url)) {
          sendMessage({ type: 'RESAVE_URL', url: item.url });
        }
      }));
    }
    var delBtn = buildAction('删除', function () {
      sendMessage({ type: 'DELETE_HISTORY', id: item.id }).then(loadHistory);
    }, true);
    actions.appendChild(delBtn);
    tdActions.appendChild(actions);

    tr.appendChild(tdTime);
    tr.appendChild(tdTitle);
    tr.appendChild(tdFormat);
    tr.appendChild(tdSize);
    tr.appendChild(tdStatus);
    tr.appendChild(tdActions);
    return tr;
  }

  /** 构建一个操作按钮。 */
  function buildAction(text, onClick, danger) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-action' + (danger ? ' danger' : '');
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** 绑定工具栏：搜索 / 导出 / 清空。 */
  function bindToolbar() {
    dom.searchInput.addEventListener('input', function () {
      renderHistory(allHistory);
    });
    dom.exportBtn.addEventListener('click', exportIndex);
    dom.clearBtn.addEventListener('click', function () {
      if (!confirm('确定清空全部快照历史记录吗？（不会删除已下载的文件）')) return;
      sendMessage({ type: 'CLEAR_HISTORY' }).then(loadHistory);
    });
  }

  /** 导出历史索引为 JSON 文件（通过浏览器下载）。 */
  function exportIndex() {
    var blob = new Blob([JSON.stringify(allHistory, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'webpage-snapshots-index.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ================================================================== */
  /* 内部工具                                                             */
  /* ================================================================== */

  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function formatTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
  }
})();
