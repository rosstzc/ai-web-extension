#!/usr/bin/env node
/**
 * server/mcp-server.js — MCP Server 入口（ai-webapi）
 *
 * 让 Claude Code / Claude Desktop / 任何 MCP 客户端把「已登录的 AI 网页」当工具调用。
 * 本进程同时担任两层：
 *   1. MCP stdio server —— 对外暴露 ask_ai / read_result / list_results 三个工具；
 *   2. WebSocket 桥 —— 监听 127.0.0.1:9898，等 Chrome 插件连入执行页面操作。
 *
 * 用法：
 *   node server/mcp-server.js                       # 作为 MCP stdio server（Claude Code 用这个）
 *   node server/mcp-server.js --http                # 调试模式：额外起 HTTP 接口，可用 curl 冒烟
 *
 * 注意：stdout 是 MCP 协议通道，所有诊断日志必须走 stderr（这里统一 console.error）。
 */
'use strict';

const path = require('path');
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Bridge } = require('./bridge');

// 诊断日志一律 stderr，绝不碰 stdout（MCP 协议通道）。
const log = (...args) => console.error('[mcp]', ...args);

const PORT = Number(process.env.AI_BRIDGE_PORT || 9898);
const HTTP_PORT = Number(process.env.AI_HTTP_PORT || 9899);

const bridge = new Bridge({ port: PORT, log });
bridge.start();

const server = new McpServer({ name: 'ai-webapi', version: '0.1.0' });

server.registerTool(
  'ask_ai',
  {
    title: '向 AI 网页提问（异步）',
    description:
      '向已登录的 AI Web 服务（当前支持 DeepSeek 网页版）提问。异步：立即返回 task_id，' +
      '完成后用 read_result 读取结果。需要 Chrome 已加载本插件、且目标 AI 网站已登录。',
    inputSchema: {
      platform: z.enum(['deepseek']).optional().describe('目标 AI 平台（当前仅 deepseek）'),
      prompt: z.string().describe('提问内容'),
      save_to: z.string().optional().describe('结果保存文件名（可选，默认 outputs/<task_id>.txt）'),
    },
  },
  async (args) => {
    const task = bridge.submitTask({
      platform: args.platform || 'deepseek',
      prompt: args.prompt,
      saveTo: args.save_to,
    });
    const connected = bridge.clientCount > 0;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            task_id: task.id,
            status: task.status,
            platform: task.platform,
            plugin_connected: connected,
            estimated_time: '约 10-60 秒',
            hint: connected
              ? '任务已下发到插件，用 read_result 读取结果'
              : '插件未连接，任务已入队；请确认 Chrome 已加载插件后稍候再 read_result',
          }),
        },
      ],
    };
  }
);

server.registerTool(
  'read_result',
  {
    title: '读取 AI 提问结果',
    description: '按 task_id 读取之前 ask_ai 提交任务的结果。任务未完成时返回 status 供轮询。',
    inputSchema: {
      task_id: z.string().describe('ask_ai 返回的任务 ID'),
    },
  },
  async (args) => {
    const task = bridge.getTask(args.task_id);
    if (!task) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: '任务不存在', task_id: args.task_id }) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            task_id: task.id,
            status: task.status,
            platform: task.platform,
            content: task.status === 'done' ? task.result : null,
            error: task.error || null,
            file: task.file || null,
            message: task.status === 'done' ? '完成' : task.status === 'error' ? '失败' : '结果尚未生成，请稍后重试',
          }),
        },
      ],
    };
  }
);

server.registerTool(
  'list_results',
  {
    title: '列出所有 AI 任务',
    description: '列出本会话内提交过的所有 AI 任务及其状态。',
    inputSchema: {},
  },
  async () => {
    const tasks = bridge.listTasks().map((t) => ({
      id: t.id,
      platform: t.platform,
      status: t.status,
      created_at: t.createdAt,
      file: t.file || null,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ tasks }) }] };
  }
);

// ===================== 调试模式：--http（curl 冒烟用） =====================
// 常规 MCP stdio 模式不动 stdout；--http 只额外起一个 HTTP 调试口，方便不用 Claude Code 验证插件链路。
function startHttpDebug() {
  http
    .createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
      const send = (code, obj) => {
        res.writeHead(code);
        res.end(JSON.stringify(obj, null, 2));
      };

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true, plugin_connected: bridge.clientCount > 0, tasks: bridge.tasks.size });
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        const tasks = bridge.listTasks().map((t) => ({
          id: t.id, platform: t.platform, status: t.status, created_at: t.createdAt, file: t.file || null,
        }));
        return send(200, { tasks });
      }
      const m = url.pathname.match(/^\/tasks\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && m) {
        const t = bridge.getTask(m[1]);
        return t ? send(200, t) : send(404, { error: '任务不存在' });
      }
      if (req.method === 'POST' && url.pathname === '/tasks') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { platform, prompt, save_to } = JSON.parse(body || '{}');
            if (!prompt) return send(400, { error: '缺少 prompt' });
            const task = bridge.submitTask({ platform: platform || 'deepseek', prompt, saveTo: save_to });
            send(200, task);
          } catch (e) {
            send(400, { error: 'JSON 解析失败: ' + e.message });
          }
        });
        return;
      }
      send(404, { error: 'not found' });
    })
    .listen(HTTP_PORT, '127.0.0.1', () => {
      log(`HTTP 调试服务 http://127.0.0.1:${HTTP_PORT}（curl 冒烟：POST /tasks → GET /tasks/<id>）`);
    });
}

// ===================== 启动 =====================
async function main() {
  if (process.argv.includes('--http')) startHttpDebug();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP Server 已连接（ai-webapi）。WS 桥端口：', PORT);
}

main().catch((err) => {
  console.error('[mcp] 启动失败:', err);
  process.exit(1);
});
