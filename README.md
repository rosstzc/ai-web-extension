# ai-webapi-extension

把**已登录的 AI 网页**（当前支持 [DeepSeek 网页版](https://chat.deepseek.com)）封装成 **MCP 服务**，让你的 AI 客户端（Claude Code / Codex / WorkBuddy 等一切支持 MCP 的工具）像调工具一样直接向 DeepSeek 提问——复用浏览器里现成的登录会话，**无 CDP、无自动化特征**。

```
你的 AI 客户端 → MCP Server → WebSocket 桥(127.0.0.1:9898) → Chrome/Edge 插件 → chat.deepseek.com 已登录页面
```

## 特性

- **反检测**：内容脚本操作真实浏览器页面，无 `navigator.webdriver`、无 CDP，DeepSeek 等站点不感知是脚本调用
- **复用登录态**：直接用你已登录的浏览器会话，无需抓 Cookie、无需账号密码
- **异步任务**：`ask_ai` 立即返回 task_id，`read_result` 轮询结果，不阻塞大模型
- **本地服务**：MCP 与桥都跑在本地 127.0.0.1，WebSocket 握手校验 `chrome-extension://` Origin 防本地劫持

## 要求

- Node ≥ 18
- Chrome 或 Edge（已登录 chat.deepseek.com）
- 任意 MCP 客户端（Claude Code / Codex / WorkBuddy / …）

## 安装

```bash
# 1. 拉取代码
git clone <仓库地址>
cd ai-webapi-extension

# 2. 装依赖（顺手把 Claude Code 的 MCP 也注册好，可加 --scope user 全局生效）
npm install
npm run setup
```

### 3. 加载浏览器插件（一次性）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录
4. 浏览器打开 https://chat.deepseek.com 并登录一次

> 插件为什么手动加载：要复用你**日常浏览器**的登录态（这是反检测的关键），加载一次即永久生效。

## 接入你的客户端

仓库根已备好 `.mcp.json`，绝大多数客户端都能直接读取：

```json
{
  "mcpServers": {
    "ai-webapi": {
      "command": "node",
      "args": ["server/mcp-server.js"]
    }
  }
}
```

- **Codex / WorkBuddy 等**：直接读取本仓库的 `.mcp.json` 即可接入。
- **Claude Code**：`npm run setup` 已自动执行 `claude mcp add ai-webapi -- node "<本仓库绝对路径>/server/mcp-server.js"`；也可手动执行同一条命令。

> 注意：`.mcp.json` 里的相对路径以**仓库根**为基准启动，请确保在仓库根目录下让客户端加载配置。

## 使用

接入后，直接自然语言调用：

```
用 ask_ai 向 DeepSeek 提问：「用一句话介绍 Vue 3」
```

可用的三个 MCP 工具：

| 工具 | 说明 | 参数 |
|---|---|---|
| `ask_ai` | 提交提问（异步） | `prompt`（必填）、`platform`（默认 deepseek）、`save_to`（可选） |
| `read_result` | 读取结果 | `task_id`（ask_ai 返回） |
| `list_results` | 列出本会话任务 | 无 |

典型流程：`ask_ai` 拿到 task_id → 等几十秒 → `read_result` 读回 DeepSeek 回复。

## 排障

| 现象 | 原因与处理 |
|---|---|
| `ask_ai` 返回 `plugin_connected: false` | 桥起了但插件没连上：确认插件已加载、MCP Server 在跑；点插件图标看状态 |
| `read_result` 一直 pending | DeepSeek 正在生成（正常）；若 >10 分钟未动，打开 DeepSeek 页看是否弹验证码/登录过期 |
| 报「未找到 DeepSeek 输入框」 | 页面未登录或改版；先手动打开 chat.deepseek.com 确认登录 |
| 插件重载后报「Receiving end does not exist」 | 已内置自愈：插件会自动刷新页面重新注入，重试即可 |
| 结果换行丢失 | 已知瑕疵：markdown 列表提取时 `<li>` 间换行未保留，内容正确仅格式丢换行 |

## curl 兜底（无 MCP 客户端时调试用）

```bash
npm run http   # 起桥 + HTTP 调试口(9899)

curl -s -X POST http://127.0.0.1:9899/tasks -H 'Content-Type: application/json' \
  -d '{"prompt":"你好","platform":"deepseek"}'
# → {"id":"<task_id>",...}

curl -s http://127.0.0.1:9899/tasks/<task_id>
# status=done 时 result 字段为回复全文
```

## 二期规划

- 更多平台：豆包 / ChatGPT / Gemini（加 `extension/adapters/<site>.js`，`ask_ai.platform` 枚举扩展）
- 文件上传（PDF/DOCX，DataTransfer 写 `input.files`）
- 流式输出、并发路由

## License

MIT
