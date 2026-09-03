/**
 * server/bridge.js — WebSocket 桥（本地）
 *
 * 职责：MCP Server（或 --http 调试模式）与 Chrome 插件之间的中转。
 *  - 插件（background service worker）主动连入 ws://127.0.0.1:9898；
 *  - MCP 提交任务 → 桥把 execute 指令推给插件 → 插件操作 DeepSeek 页面 → 结果回传 → 桥落盘 + 记状态。
 *
 * 协议（JSON，均为对象）：
 *   server → ext : { type:'execute', taskId, platform, prompt }
 *   server → ext : { type:'ping' }                                  // 心跳保活 MV3 SW
 *   ext → server : { type:'ready' }                                 // 插件连上后报告就绪
 *   ext → server : { type:'pong' }
 *   ext → server : { type:'result', taskId, result }
 *   ext → server : { type:'error',  taskId, error }
 *
 * 安全：仅接受 Origin 以 chrome-extension:// 开头的连接，挡掉任意网页发起的
 * 本地 WebSocket 劫持（DNS rebinding / localhost WS 攻击）。MVP 不加密。
 */
'use strict';

const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 9898;

class Bridge {
  /**
   * @param {{ port?: number, outputDir?: string, log?: Function }} [options]
   */
  constructor({ port = DEFAULT_PORT, outputDir = path.join(process.cwd(), 'outputs'), log } = {}) {
    this.port = port;
    this.outputDir = outputDir;
    // 诊断日志统一走 log()；被 MCP Server 内嵌时必须注入 stderr，否则 console.log 会污染 MCP 的 stdout 协议通道。
    this.log = log || console.log;
    this.clients = new Set();   // 已连接的插件 WS
    this.tasks = new Map();     // taskId -> task
    this.wss = null;
    this._httpServer = null;
    this._pingTimer = null;
    /** 结果回调（MCP Server 可挂进来，如写日志/通知）。@type {((taskId:string, task:object)=>void)|null} */
    this.onResult = null;
  }

  start() {
    // 用 noServer + 手动 upgrade 事件，在 WebSocket 握手前就校验 Origin（拒绝任意网页的本地 WS 劫持）
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this._httpServer = http.createServer();
    this._httpServer.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin || '';
      if (!origin.startsWith('chrome-extension://')) {
        this.log(`[bridge] 握手前拒绝非扩展来源: ${origin || '(无 Origin)'}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this._httpServer.listen(this.port, '127.0.0.1', () => {
      this.log(`[bridge] WS 监听 ws://127.0.0.1:${this.port}（等插件连入）`);
    });
    this.wss.on('connection', (socket, req) => this._handleConnection(socket, req));
    this.wss.on('error', (err) => this.log('[bridge] WS 服务错误:', err.message));

    // 心跳：每 25s ping，保活插件 MV3 Service Worker（Chrome 约 30s 无活动会挂起 SW）
    this._pingTimer = setInterval(() => {
      for (const c of this.clients) {
        if (c.readyState === 1 /* OPEN */) c.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
    this._pingTimer.unref?.();

    // 从磁盘恢复历史任务记录（重启不丢：read_result / list_results 能查到已完成任务）
    this.hydrateFromDisk();

    return this;
  }

  stop() {
    clearInterval(this._pingTimer);
    if (this.wss) this.wss.close();
    if (this._httpServer) this._httpServer.close();
  }

  get clientCount() {
    return this.clients.size;
  }

  // ===================== 任务 API（给 MCP Server / HTTP 调试用） =====================

  /**
   * 提交一个任务，立即返回 task 对象（异步执行，不阻塞）。
   * 若有插件在线则立刻下发 execute；否则任务留在队列，等插件连入时补发。
   * @param {{platform:string, prompt:string, saveTo?:string}} params
   */
  submitTask({ platform, prompt, saveTo }) {
    const task = {
      id: crypto.randomUUID(),
      platform,
      prompt,
      saveTo,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    this._dispatchToFirst(task);
    return task;
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  listTasks() {
    return Array.from(this.tasks.values());
  }

  /**
   * 把任务的元数据写成 .json 侧车（跟结果 txt 同目录），重启后可恢复记录。
   * 侧车只存元数据（id/平台/状态/时间/文件路径），**不含结果正文**——正文在 txt 里。
   */
  _writeRecord(task) {
    const meta = {
      id: task.id,
      platform: task.platform,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: task.completedAt || null,
      error: task.error || null,
      file: task.file || null,
      saveTo: task.saveTo || null,
    };
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      const sidecar = path.join(this.outputDir, `${task.id}.json`);
      fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
      this.log('[bridge] 写 .json 侧车失败:', e.message);
    }
  }

  /** 从 outputs/ 的 .json 侧车恢复历史任务（done/error 已完成的任务），实现"重启记录不丢"。 */
  hydrateFromDisk() {
    let loaded = 0;
    try {
      if (!fs.existsSync(this.outputDir)) return loaded;
      for (const fname of fs.readdirSync(this.outputDir)) {
        if (!fname.endsWith('.json')) continue;
        const p = path.join(this.outputDir, fname);
        try {
          const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (!meta || !meta.id) continue;
          if (this.tasks.has(meta.id)) continue; // 不覆盖内存里的活任务
          this.tasks.set(meta.id, {
            id: meta.id,
            platform: meta.platform,
            status: meta.status,
            createdAt: meta.createdAt,
            completedAt: meta.completedAt || null,
            error: meta.error || null,
            file: meta.file || null,
            saveTo: meta.saveTo || null,
          });
          loaded++;
        } catch {
          // 单个坏侧车跳过，不影响其它
        }
      }
    } catch (e) {
      this.log('[bridge] 恢复历史记录失败:', e.message);
    }
    if (loaded) this.log(`[bridge] 已从磁盘恢复 ${loaded} 条历史任务`);
    return loaded;
  }

  /**
   * 取任务结果正文。内存里有 result 直接用；否则（如重启后从侧车恢复的）
   * 若任务完成且有落盘文件，则读文件返回。
   * @returns {string|null} 正文；未完成/无文件时返回 null
   */
  getContent(task) {
    if (!task) return null;
    if (task.status !== 'done') return null;
    if (task.result != null) return task.result;
    if (task.file) {
      try {
        return fs.readFileSync(task.file, 'utf8');
      } catch {
        return null;
      }
    }
    return null;
  }

  // ===================== WS 连接处理 =====================

  _handleConnection(socket, req) {
    // 纵深防御：Origin 已在 HTTP upgrade 阶段校验过，这里再查一次，防止后续改动破坏升级校验。
    const origin = req.headers.origin || '';
    if (!origin.startsWith('chrome-extension://')) {
      this.log(`[bridge] 拒绝非扩展来源的连接: ${origin || '(无 Origin)'}（本地安全保护）`);
      socket.close(1008, 'invalid origin');
      return;
    }

    this.clients.add(socket);
    this.log(`[bridge] 插件已连接（当前 ${this.clients.size} 个）`);

    // 新插件连入：把之前 queued / pending（可能被断开的客户端带走了）的任务重新下发
    for (const task of this.tasks.values()) {
      if (task.status === 'queued' || task.status === 'pending') {
        this._dispatch(socket, task);
      }
    }

    socket.on('message', (data) => this._handleMessage(socket, data));
    socket.on('close', () => {
      this.clients.delete(socket);
      this.log(`[bridge] 插件断开（剩余 ${this.clients.size} 个）`);
    });
    socket.on('error', () => { /* 断线时 close 事件会跟进，忽略 */ });
  }

  _handleMessage(socket, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return; // 非 JSON，忽略
    }
    switch (msg.type) {
      case 'result':
        this._complete(msg.taskId, { status: 'done', result: msg.result });
        break;
      case 'error':
        this._complete(msg.taskId, { status: 'error', error: msg.error });
        break;
      case 'ready':
      case 'pong':
        break; // 握手/心跳应答，无操作
      default:
        break;
    }
  }

  /** 任务完成：更新状态 + 结果落盘 + 通知回调。 */
  _complete(taskId, patch) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, patch, { completedAt: new Date().toISOString() });

    if (task.status === 'done') {
      try {
        fs.mkdirSync(this.outputDir, { recursive: true });
        const file = path.join(this.outputDir, task.saveTo || `${task.id}.txt`);
        fs.writeFileSync(file, task.result || '', 'utf8');
        task.file = file;
      } catch (e) {
        this.log('[bridge] 结果落盘失败:', e.message);
      }
    }

    // 结果旁写 .json 侧车（任务元数据，不含正文）：重启后仍能查到记录
    this._writeRecord(task);

    this.log(`[bridge] 任务 ${taskId} → ${task.status}${task.error ? `：${task.error}` : ''}`);

    if (this.onResult) {
      try { this.onResult(taskId, task); } catch (e) { this.log('[bridge] onResult 回调异常:', e.message); }
    }
  }

  /** 把 execute 指令发给第一个在线插件；无在线插件则保持 queued。 */
  _dispatchToFirst(task) {
    for (const c of this.clients) {
      if (c.readyState === 1) {
        this._dispatch(c, task);
        return;
      }
    }
    this.log(`[bridge] 任务 ${task.id} 已入队（无在线插件，等连入后补发）`);
  }

  _dispatch(socket, task) {
    if (task.status !== 'queued' && task.status !== 'pending') return;
    task.status = 'pending';
    this.log(`[bridge] → execute 任务 ${task.id}（${task.platform}）`);
    socket.send(JSON.stringify({
      type: 'execute',
      taskId: task.id,
      platform: task.platform,
      prompt: task.prompt,
    }));
  }
}

module.exports = { Bridge, DEFAULT_PORT };
