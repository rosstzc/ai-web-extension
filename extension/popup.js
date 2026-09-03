/**
 * extension/popup.js — 弹出窗：桥连接状态 + DeepSeek 页面链路自测。
 */
'use strict';

const el = {
  bridge: document.getElementById('bridge-status'),
  page: document.getElementById('page-status'),
  test: document.getElementById('test'),
  result: document.getElementById('result'),
};

function setStatus(node, ok, text) {
  node.innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span>${text}`;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (res) setStatus(el.bridge, res.connected, res.connected ? '已连接' : '未连接');
  });
}

el.test.addEventListener('click', () => {
  el.result.textContent = '测试中…';
  chrome.runtime.sendMessage({ type: 'test' }, (res) => {
    if (!res) { el.result.className = 'err'; el.result.textContent = '无响应（可能页面未就绪）'; return; }
    if (res.ok) {
      setStatus(el.page, true, '可达');
      el.result.className = 'ok-text';
      el.result.textContent = `链路正常：插件 → DeepSeek 页（tab ${res.tabId}）✓  WS ${res.wsConnected ? '已连接' : '未连接'}`;
    } else {
      setStatus(el.page, false, '不可达');
      el.result.className = 'err';
      el.result.textContent = 'DeepSeek 页面不可达：' + (res.error || '未知错误');
    }
  });
});

refresh();
setInterval(refresh, 2000);
