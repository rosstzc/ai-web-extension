/**
 * extension/content-script.js — 内容脚本命令分发
 *
 * 监听 background 转来的指令，调用对应平台适配器（见 adapters/deepseek.js），结果回传。
 * 与页面共享 DOM，但运行在隔离世界：无 CDP、无 navigator.webdriver，是"无自动化特征"的关键。
 */
(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    switch (message.type) {
      case 'ask': {
        // DeepSeek 适配（MVP 仅此一个平台；二期按 message.platform 分发到 adapters/<site>.js）
        if (message.platform && message.platform !== 'deepseek') {
          sendResponse({ success: false, error: `未知平台：${message.platform}` });
          return false;
        }
        const opts = message.opts || {};
        DSAdapter.ask(message.prompt, opts)
          .then((content) => sendResponse({ success: true, content }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true; // 保持消息通道，异步响应
      }
      case 'ping': {
        // 连通性测试：确认本内容脚本已注入
        sendResponse({ success: true, pong: true });
        return false;
      }
      default:
        return false;
    }
  });
})();
