#!/usr/bin/env node
/**
 * scripts/install.js — ai-webapi-extension 一键安装
 *
 * 做三件事：
 *  1. npm install（--ignore-scripts 防递归）
 *  2. 全局注册 MCP（claude mcp add --scope user），让用户在自己【任意】项目的 Claude Code 里都能用 ask_ai
 *  3. 打印手动加载浏览器插件的步骤 + 验证方式
 *
 * 用法：npm run setup   或   node scripts/install.js
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SERVER_FILE = path.join(ROOT, 'server', 'mcp-server.js');
const MCP_NAME = 'ai-webapi';

function banner(title) {
  console.log('\n' + '='.repeat(58));
  console.log(`  ${title}`);
  console.log('='.repeat(58));
}

/** 全局注册 MCP（幂等：已注册则跳过）。 */
function registerMcp() {
  const addCmd = `claude mcp add ${MCP_NAME} --scope user -- node "${SERVER_FILE}"`;

  // 幂等：先 list 检查是否已注册
  try {
    const list = execSync('claude mcp list', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (list.includes(MCP_NAME)) {
      console.log(`  ⏭  已注册 ${MCP_NAME}（scope=user），跳过`);
      return;
    }
  } catch (e) {
    // claude CLI 不可用或 list 失败：继续尝试 add（add 会给出明确报错）
  }

  try {
    execSync(addCmd, { stdio: 'inherit' });
    console.log(`  ✅ 已全局注册 ${MCP_NAME}（任意项目的 Claude Code 都能用）`);
  } catch (e) {
    console.warn(`  ⚠  自动注册失败，请手动执行：`);
    console.warn(`     ${addCmd}`);
  }
}

function main() {
  banner('ai-webapi-extension 安装');

  // 1. 依赖
  console.log('\n[1/4] 📦 安装 npm 依赖...');
  execSync('npm install --ignore-scripts', { stdio: 'inherit', cwd: ROOT });

  // 2. MCP 全局注册
  banner('[2/4] 注册 MCP（全局）');
  console.log('  注册工具 ask_ai / read_result / list_results...');
  registerMcp();

  // 3. 插件手动加载
  banner('[3/4] 加载浏览器插件（一次性，手动）');
  console.log(`
  1. 打开 chrome://extensions（Edge 为 edge://extensions）
  2. 右上角开启「开发者模式」
  3. 点「加载已解压的扩展程序」→ 选择目录：
     ${EXT_DIR}
  4. 打开 https://chat.deepseek.com 并登录（插件操作用的就是这个登录会话）

  为什么手动：插件要复用你日常浏览器的登录态（无 CDP、无自动化特征），
  手动加载一次即永久生效。`);

  // 4. 验证
  banner('[4/4] 验证');
  console.log(`
  装好后，在【任意】项目的 Claude Code 里说：
    「用 ask_ai 问 DeepSeek 一个问题」

  或起调试 HTTP 口 curl 冒烟：
    npm run http
    curl -s -X POST http://127.0.0.1:9899/tasks -H 'Content-Type: application/json' -d '{"prompt":"你好"}'
    curl -s http://127.0.0.1:9899/tasks/<task_id>`);

  console.log('\n✅ 安装完成。\n');
}

try {
  main();
} catch (e) {
  console.error('❌ 安装失败:', e.message);
  process.exit(1);
}
