/**
 * extension/background.js — Service Worker
 *
 * 职责：
 *  1. 主动连入本地桥 ws://127.0.0.1:9898（MCP Server 起），断线指数退避重连；
 *  2. 收到 execute 指令 → 找/建 DeepSeek 标签页 → 转发给 content-script → 结果回传；
 *  3. 响应 server 的心跳 ping（保活 MV3 SW），以及 popup 的状态查询 / 链路测试。
 *
 * 安全：连入本地桥时不发敏感信息；桥端会校验 Origin 为 chrome-extension:// 才放行。
 */
'use strict';

const WS_URL = 'ws://127.0.0.1:9898';
const DEEPSEEK_URL = 'https://chat.deepseek.com/';

let ws = null;
let reconnectDelay = 1000;      // 指数退避起始 1s，封顶 30s
let reconnectTimer = null;

function log(...args) { console.log('[ai-webapi-bg]', ...args); }

// ===================== WebSocket 连接 =====================

function connect() {
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    log('WS 创建失败:', e.message);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    log('WS 已连接', WS_URL);
    reconnectDelay = 1000;
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    log('WS 断开，准备重连');
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // close 事件会跟进，这里只需把连接置为可关闭
    try { ws.close(); } catch (e) { /* 忽略 */ }
  };
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  }
}

// ===================== 消息处理 =====================

function handleMessage(msg) {
  switch (msg.type) {
    case 'execute':
      enqueueTask(msg.taskId, msg.platform, msg.prompt);
      break;
    case 'ping':
      send({ type: 'pong' }); // 保活应答
      break;
    default:
      break;
  }
}

/**
 * 串行队列：同一页面只能同时操作一个任务。
 * 若不串行，多个 executeTask 会并发操作同一个标签页的输入框互相踩踏
 * （后一个任务的输入覆盖前一个，两个任务提取到同一份回答）。
 */
let taskQueue = Promise.resolve();

function enqueueTask(taskId, platform, prompt) {
  taskQueue = taskQueue
    .then(() => executeTask(taskId, platform, prompt))
    .catch((e) => {
      // executeTask 内部已处理错误并回传桥；这里兜底防队列中断
      log('任务执行异常（队列兜底）:', e.message);
      send({ type: 'error', taskId, error: e.message });
    });
}

/**
 * 执行一次任务：新开 DeepSeek 标签页 → 调 content-script → 结果回传桥。
 * 任务完成（无论成败）后 1 分钟自动关闭本次新开的标签页，不打扰用户已有页面。
 */
async function executeTask(taskId, platform, prompt) {
  let taskTabId = null;
  try {
    if (platform !== 'deepseek') {
      send({ type: 'error', taskId, error: `未知平台：${platform}` });
      return;
    }
    const tab = await createTaskTab(DEEPSEEK_URL);
    taskTabId = tab.id;
    const result = await sendAskWithReloadHeal(tab, prompt);
    if (result && result.success) {
      send({ type: 'result', taskId, result: result.content });
    } else {
      send({ type: 'error', taskId, error: (result && result.error) || 'content script 无响应' });
    }
  } catch (e) {
    send({ type: 'error', taskId, error: e.message });
  } finally {
    // 任务收尾：1 分钟后自动关闭本次新开的标签页
    if (taskTabId) scheduleTaskTabClose(taskTabId);
  }
}

/** 每次任务都新开一个 DeepSeek 标签页（后台静默，复用已登录会话），不碰用户已有标签页。 */
async function createTaskTab(url) {
  return await chrome.tabs.create({ url, active: false });
}

/** 任务完成后延迟 1 分钟关闭标签页（用 alarms，避免 MV3 SW 挂起时 setTimeout 被冻结）。 */
function scheduleTaskTabClose(tabId) {
  try {
    chrome.alarms.create(`close-task-tab-${tabId}`, { delayInMinutes: 1 });
  } catch (e) {
    // alarms 不可用时兜底 setTimeout
    setTimeout(() => { try { chrome.tabs.remove(tabId); } catch (e2) { /* 标签页可能已被手动关闭 */ } }, 60000);
  }
}

/**
 * 向 content-script 发 ask 并自愈：若 content script 失联（插件重载后旧页面接收端消失、
 * 页面陈旧等），自动刷新标签页重新注入 content-script，再重试一轮。
 */
async function sendAskWithReloadHeal(tab, prompt) {
  const msg = { type: 'ask', platform: 'deepseek', prompt, opts: { deepthink: true } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sendToTabWithRetry(tab.id, msg);
    } catch (e) {
      if (attempt === 0) {
        log('content script 未就绪，刷新标签页重新注入后重试：', e.message);
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id);
      } else {
        throw e;
      }
    }
  }
}

/** 等待标签页重新加载完成（注入 content-script 需要等 document_idle）。 */
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('刷新后等待页面加载超时'));
    }, timeoutMs);
    const onUpdated = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** 找已有 DeepSeek 标签页（复用，不新建打扰），没有则后台静默新建。 */
async function getOrCreateTab(url) {
  const tabs = await chrome.tabs.query({ url: url + '*' });
  if (tabs.length > 0) return tabs[0];
  return await chrome.tabs.create({ url, active: false });
}

/**
 * 向 content-script 发消息并重试。
 * 新建标签页时内容脚本在 document_idle 才注入，需要轮询等它就绪。
 */
async function sendToTabWithRetry(tabId, msg, attempts = 8, delay = 1000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    'content script 未就绪（页面未加载完成或未登录 chat.deepseek.com）：' + (lastErr && lastErr.message)
  );
}

// ===================== popup 通信 =====================

/** MV3 SW 挂起自愈：任何事件唤醒 SW 时，若 WS 未连接则立即重连。
 *   （SW 闲置 ~30s 会被挂起，挂起期间重连计时器冻结；需要由事件触发补连。） */
function ensureConnected() {
  if (!(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) {
    connect();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'getStatus') {
    ensureConnected();
    sendResponse({ connected: !!(ws && ws.readyState === 1) });
    return false;
  }
  if (msg.type === 'test') {
    ensureConnected();
    testChain()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// 标签页状态变化也会唤醒 SW；页面上打开/刷新 chat.deepseek.com 即触发补连。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') ensureConnected();
});

// 任务标签页延迟关闭：executeTask 结束时注册的 close-task-tab-<id> alarm 到期即关。
// 周期保活 alarm：SW 挂起后重连计时器冻结，靠这个每 30s 主动唤醒 SW 补连（无需人工刷新/开新页）。
const KEEPALIVE_ALARM = 'ws-keepalive';
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === KEEPALIVE_ALARM) {
    ensureConnected();
    return;
  }
  const m = /^close-task-tab-(\d+)$/.exec(alarm.name || '');
  if (!m) return;
  const tabId = Number(m[1]);
  log('自动关闭任务标签页 #', tabId);
  chrome.tabs.remove(tabId).catch(() => { /* 标签页可能已被手动关闭，忽略 */ });
});

/** 链路自测：WS 是否连着 + DeepSeek 标签页能否 ping 通 content-script。 */
async function testChain() {
  const tab = await getOrCreateTab(DEEPSEEK_URL);
  const res = await sendToTabWithRetry(tab.id, { type: 'ping' });
  return {
    ok: !!(res && res.pong),
    wsConnected: !!(ws && ws.readyState === 1),
    tabId: tab.id,
  };
}

// ===================== 启动 =====================

chrome.runtime.onStartup.addListener(() => { if (!ws) connect(); });
connect();
log('Service Worker 启动');
