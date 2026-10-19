/**
 * @file src/popup/popup.js
 * @description 弹窗逻辑：读取当前标签页与设置，渲染界面；
 *              点击保存后向 Service Worker 发 POPUP_SAVE 消息，
 *              并通过 SAVE_PROGRESS / SAVE_DONE / SAVE_ERROR 展示进度。
 *
 * 约定：设置与历史直接读写 chrome.storage（少一跳消息）；
 *       只有"保存"这类动作才走 Service Worker。
 */
(function () {
  'use strict';

  /** DOM 引用集中声明，避免散落查询 */
  var dom = {
    pageTitle: document.getElementById('page-title'),
    pageUrl: document.getElementById('page-url'),
    formatRadios: document.getElementById('format-radios'),
    formatHint: document.getElementById('format-hint'),
    bannerToggle: document.getElementById('banner-toggle'),
    saveBtn: document.getElementById('save-btn'),
    grantBtn: document.getElementById('grant-btn'),
    status: document.getElementById('status'),
    recentList: document.getElementById('recent-list'),
    openLibrary: document.getElementById('open-library')
  };

  /** 当前标签页信息 */
  var currentTab = null;

  document.addEventListener('DOMContentLoaded', init);

  /**
   * 初始化：并行读取标签页、设置、历史，然后渲染。
   * @returns {Promise<void>}
   */
  async function init() {
    var results = await Promise.all([
      getActiveTab(),
      chrome.storage.local.get(['settings', 'history'])
    ]);
    currentTab = results[0];
    var data = results[1] || {};
    var settings = Object.assign({ banner: true, format: 'auto' }, data.settings || {});

    renderPageInfo(currentTab);
    renderFormat(settings.format);
    dom.bannerToggle.checked = settings.banner !== false;
    renderRecent(data.history || []);
    bindEvents();
    updateFormatHint();
  }

  /** 渲染当前页标题与 URL。 */
  function renderPageInfo(tab) {
    if (!tab) {
      dom.pageTitle.textContent = '无法读取当前页面';
      return;
    }
    dom.pageTitle.textContent = tab.title || '(无标题)';
    dom.pageUrl.textContent = tab.url || '';
  }

  /** 渲染格式单选状态。 */
  function renderFormat(format) {
    var radios = dom.formatRadios.querySelectorAll('input[type=radio]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = radios[i].value === format;
    }
  }

  /** 渲染最近 3 条保存记录。 */
  function renderRecent(history) {
    dom.recentList.innerHTML = '';
    var items = (history || []).filter(function (h) { return h.status === 'success'; }).slice(0, 3);
    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'ws-empty';
      empty.textContent = '暂无保存记录';
      dom.recentList.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var li = document.createElement('li');
      var title = document.createElement('span');
      title.className = 'ws-r-title';
      title.textContent = item.title || item.url || '';
      title.title = item.title || item.url || '';
      var time = document.createElement('span');
      time.className = 'ws-r-time';
      time.textContent = formatTime(item.savedAt);
      li.appendChild(title);
      li.appendChild(time);
      dom.recentList.appendChild(li);
    });
  }

  /** 绑定界面事件。 */
  function bindEvents() {
    dom.saveBtn.addEventListener('click', onSaveClick);
    dom.grantBtn.addEventListener('click', onGrantClick);
    dom.bannerToggle.addEventListener('change', function () {
      chrome.storage.local.get('settings', function (data) {
        var settings = Object.assign({}, data.settings || {}, { banner: dom.bannerToggle.checked });
        chrome.storage.local.set({ settings: settings });
      });
    });
    dom.formatRadios.addEventListener('change', updateFormatHint);
    dom.openLibrary.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    // 监听 SW 广播的进度/结果
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'SAVE_PROGRESS') showStatus(msg.message, 'info');
      else if (msg.type === 'SAVE_DONE') onSaveDone(msg.result);
      else if (msg.type === 'SAVE_ERROR') onSaveError(msg.error);
    });
  }

  /** 点击保存：MHTML 格式且未授权时，先引导授权。 */
  async function onSaveClick() {
    if (!currentTab || currentTab.id == null) {
      showStatus('无法读取当前标签页', 'error');
      return;
    }
    var format = getSelectedFormat();
    var settings = await chrome.storage.local.get('settings');
    var options = { format: format, banner: dom.bannerToggle.checked };

    if (format === 'mhtml') {
      var granted = await hasPermission('pageCapture');
      if (!granted) {
        // 无用户手势时 SW 内无法申请权限，引导用户在弹窗内点击授权
        dom.grantBtn.hidden = false;
        showStatus('需要授予"页面捕获"权限才能使用原生 MHTML', 'info');
        return;
      }
    }
    dom.grantBtn.hidden = true;
    setSaving(true);
    sendMessage({ type: 'POPUP_SAVE', tabId: currentTab.id, options: options });
  }

  /** 授权按钮：在弹窗内申请 pageCapture 可选权限。 */
  function onGrantClick() {
    chrome.permissions.request({ permissions: ['pageCapture'] }, function (granted) {
      if (granted) {
        dom.grantBtn.hidden = true;
        showStatus('已授权，再次点击保存即可', 'success');
      } else {
        showStatus('已拒绝授权，可改用"单文件 HTML"格式', 'error');
      }
    });
  }

  /** 保存成功。 */
  function onSaveDone(result) {
    setSaving(false);
    if (!result) {
      showStatus('保存完成', 'success');
      return;
    }
    var text = '已保存：' + (result.filename || '') +
      (result.bytes ? '（' + formatBytes(result.bytes) + '）' : '');
    if (result.warnings && result.warnings.length) {
      text += '，' + result.warnings.length + ' 个资源未能内嵌（已保留原地址）';
    }
    showStatus(text, 'success');
    refreshRecent();
  }

  /** 保存失败。 */
  function onSaveError(error) {
    setSaving(false);
    showStatus('保存失败：' + error, 'error');
  }

  /** 刷新最近记录。 */
  function refreshRecent() {
    chrome.storage.local.get('history', function (data) {
      renderRecent(data.history || []);
    });
  }

  /* ---------------- 内部工具 ---------------- */

  function getActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0]);
      });
    });
  }

  function getSelectedFormat() {
    var radios = dom.formatRadios.querySelectorAll('input[type=radio]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) return radios[i].value;
    }
    return 'auto';
  }

  function hasPermission(name) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.contains({ permissions: [name] }, function (granted) {
          resolve(!!granted);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * 根据格式与浏览器能力更新提示文案。
   */
  async function updateFormatHint() {
    var format = getSelectedFormat();
    var hasApi = typeof chrome.pageCapture !== 'undefined' &&
      typeof chrome.pageCapture.saveAsMHTML === 'function';
    if (format === 'auto') {
      dom.formatHint.textContent = hasApi
        ? '已授权时优先使用原生 MHTML，否则自动使用单文件 HTML'
        : '当前浏览器不支持原生 MHTML，将使用单文件 HTML';
    } else if (format === 'mhtml') {
      dom.formatHint.textContent = hasApi
        ? '仅 Chrome 支持，需授予页面捕获权限'
        : '当前浏览器不支持原生 MHTML，请改用单文件 HTML';
    } else {
      dom.formatHint.textContent = '所有浏览器通用，资源以 data URI 内联';
    }
    // 非 Chrome 隐藏 MHTML 相关入口
    var mhtmlLabel = dom.formatRadios.querySelector('input[value=mhtml]');
    if (mhtmlLabel) mhtmlLabel.parentElement.style.display = hasApi ? '' : 'none';
  }

  function showStatus(text, level) {
    dom.status.hidden = false;
    dom.status.textContent = text;
    dom.status.className = 'ws-status ' + (level || 'info');
  }

  function setSaving(on) {
    dom.saveBtn.disabled = on;
    dom.saveBtn.textContent = on ? '保存中…' : '保存当前网页';
  }

  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
  }
})();
