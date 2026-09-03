/**
 * extension/adapters/deepseek.js — DeepSeek 网页版站点适配（内容脚本专用）
 *
 * 移植自 findjob 项目 deepseek.js 的 DOM 适配知识（输入框/回复选择器、深度思考开关、流式完成判定），
 * 但运行在 Chrome 内容脚本里（页面真实 DOM，无 CDP）。本文件在 manifest content_scripts 中先于
 * content-script.js 加载，暴露全局 DSAdapter 供其调用。
 *
 * 适配要点（UI 改版只改本文件顶部选择器常量）：
 *  - 输入框：DeepSeek 是 React，直接 el.value= 不触发 onChange；用 document.execCommand('insertText')
 *    一次写入（等价粘贴，React 可识别），失败退回原生 value setter + input 事件。
 *  - 发送：焦点在输入框时 dispatch Enter 键事件；DeepSeek 只在 React state 有文本时才允许发送，
 *    execCommand 写入后 state 已就绪。若 Enter 未触发发送（输入框未清空），回退点发送按钮。
 *  - 完成判定：轮询最后一条回复 textContent，连续 ~2s 长度稳定视为生成完成。
 */
(() => {
  'use strict';

  // ===================== 选择器常量（UI 改版改这里） =====================
  const INPUT_SELECTORS = [
    "textarea[placeholder*='DeepSeek']",
    '#chat-input-area textarea',
    'main textarea',
    'div.ds-input textarea',
    'div[contenteditable="true"]',
  ];
  const RESPONSE_SELECTORS = [
    '.ds-markdown',
    '.markdown-body',
    '[class*="markdown"]',
    '[class*="message"]',
  ];
  const SEND_BUTTON_SELECTORS = [
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'button[aria-label="发送消息"]',
  ];

  function findSelector(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return { sel, el };
    }
    return null;
  }

  function findInput() {
    const hit = findSelector(INPUT_SELECTORS);
    return hit ? hit.el : null;
  }

  /**
   * 轮询等待输入框出现。DeepSeek 是 SPA：页面 complete 后 React 还需数秒挂载渲染，
   * 且刷新/新建标签页后可能先经过登录跳转，输入框不会立刻存在。等 timeout 内出现则返回，否则 null。
   */
  async function waitForInput(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = findInput();
      if (input) return input;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** 统一取输入控件文本（textarea/input 用 value，contenteditable 用 textContent）。 */
  function inputText(el) {
    if (el.value !== undefined) return el.value;
    return el.textContent || '';
  }

  /** 获取最后一条回复状态（count + lastText），用于检测「新回复」出现。 */
  function getResponseState() {
    for (const sel of RESPONSE_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        const last = nodes[nodes.length - 1];
        return { count: nodes.length, lastText: last ? last.textContent : '' };
      }
    }
    return { count: 0, lastText: '' };
  }

  /** 取最后一条回复的完整文本。 */
  function extractLast() {
    for (const sel of RESPONSE_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        const last = nodes[nodes.length - 1];
        return last ? last.textContent.trim() : '';
      }
    }
    return '';
  }

  /**
   * 确保「深度思考」开关处于开启状态（移植 findjob deepseek.js enableDeepThink）。
   * 已开启不重复点击；状态无法判断时跳过（不盲点，避免误关）。
   */
  async function ensureDeepThink() {
    const res = (() => {
      const nodes = document.querySelectorAll(
        'div[class*="ds-toggle-button"], button, div[role="button"], div[role="switch"], [role="checkbox"]'
      );
      for (const el of nodes) {
        const text = (el.textContent || '').trim();
        if (!/DeepThink|深度思考/.test(text)) continue;
        const aria = (el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || '').toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        const activeClass =
          /(^|[\s_-])(active|on|checked|selected|enabled)([\s_-]|$)/.test(cls) ||
          cls.includes('is-active') ||
          cls.includes('is-on');
        const state = aria === 'true' ? true : aria === 'false' ? false : activeClass ? true : null;
        return { found: true, state, el };
      }
      return { found: false, state: null };
    })();

    if (!res.found) {
      console.warn('[adapter] 未找到「深度思考」按钮（UI 可能改版），跳过');
      return false;
    }
    if (res.state === true) return true;
    if (res.state === null) {
      console.warn('[adapter] 「深度思考」状态无法判断（无 aria/开关类标记），跳过点击以免误关');
      return false;
    }
    res.el.click();
    await new Promise((r) => setTimeout(r, 800));
    console.log('[adapter] 已开启 DeepThink（深度思考）');
    return true;
  }

  /** 聚焦 + 全选 + 一次性写入文本，返回实际写入长度。 */
  function fillInput(input, text) {
    input.focus();
    try {
      if (input.setSelectionRange) input.setSelectionRange(0, inputText(input).length);
    } catch (e) { /* 忽略 */ }

    let written = 0;

    // ① document.execCommand('insertText')：等价粘贴（React 可识别），大文本一次写入
    try {
      const ok = document.execCommand('insertText', false, text);
      if (ok) written = inputText(input).length;
    } catch (e) { /* 继续 */ }

    // ② 兜底：原生 value setter + input 事件（React 输入控件标准做法）
    if (written !== text.length && input.tagName === 'TEXTAREA') {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        written = inputText(input).length;
      } catch (e) { /* 继续 */ }
    }

    // ③ contenteditable 兜底
    if (written !== text.length && input.isContentEditable) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      written = text.length;
    }

    return written;
  }

  /** 等输入框被清空（发送成功的信号），超时返回 false。 */
  function waitInputClear(input, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (!input.isConnected || inputText(input).length === 0) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  /** 发送：先 dispatch Enter，等输入框清空；未清空则回退点发送按钮。 */
  async function sendMessage(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

    let cleared = await waitInputClear(input, 3000);
    if (cleared) return;

    // 回退：点发送按钮
    const hit = findSelector(SEND_BUTTON_SELECTORS);
    if (hit) hit.el.click();
    cleared = await waitInputClear(input, 8000);
    if (!cleared) throw new Error('发送失败：按 Enter / 点发送按钮后输入框未清空');
  }

  /**
   * 等待「新回复」流式完成并返回全文。
   * 默认：最后一条回复长度连续 ~2s 稳定视为完成。
   * opts.isComplete(content)->boolean 提供时用结构化完成判定（命中且连续 ~1s 不变才收尾，挡思考草稿误判）。
   */
  async function waitAndExtract(before, timeout, isComplete) {
    const start = Date.now();
    let content = '';
    if (typeof isComplete === 'function') {
      let hits = 0;
      let lastMatched = null;
      while (Date.now() - start < timeout) {
        content = extractLast();
        const done = isComplete(content);
        if (done) {
          if (content === lastMatched) { hits += 1; if (hits >= 2) break; }
          else { hits = 1; lastMatched = content; }
        } else {
          hits = 0; lastMatched = null;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } else {
      let lastLen = -1;
      let stable = 0;
      while (Date.now() - start < timeout) {
        content = extractLast();
        const len = content.length;
        if (len === lastLen && len > 0) { stable += 1; if (stable >= 4) break; }
        else { stable = 0; }
        lastLen = len;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return extractLast();
  }

  /**
   * 向 DeepSeek 网页版提问，返回完整回复文本。
   * @param {string} prompt
   * @param {{deepthink?:boolean, timeout?:number, isComplete?:Function}} [opts]
   */
  async function ask(prompt, opts = {}) {
    const timeout = opts.timeout || 600000;
    const deepthink = opts.deepthink !== false;

    const input = await waitForInput();
    if (!input) throw new Error('未找到 DeepSeek 输入框，请确认已登录 chat.deepseek.com 且页面已加载');

    if (deepthink) await ensureDeepThink();
    const before = getResponseState();

    const written = fillInput(input, prompt);
    if (written < prompt.length) {
      throw new Error(`输入框仅写入 ${written}/${prompt.length} 字符（值不完整，可能含无法写入的控制字符）`);
    }

    await sendMessage(input);

    const content = await waitAndExtract(before, timeout, opts.isComplete);
    if (!content) throw new Error('未获取到回复（可能回复失败或超时）');
    return content;
  }

  globalThis.DSAdapter = { ask };
})();
