# 灵枢智训 · 后端服务

消费者对话 Agent（Kimi 扮演）+ 确定性会话控制 + 可追溯知识库（RAG）+ 评分 Agent，接入前端网站。

## 系统架构

```
浏览器前端 (output/index.html)
      │  POST /api/chat、/api/evaluate
      ▼
Node 后端 (backend/server.js)
      ├── 消费者对话 Agent（结构化回复，严格释放隐藏信息）
      ├── 规则层（合规预检、状态更新、停止机制）
      ├── 评分 Agent（证据化四维分析）
      └── 知识库（59 个编号条目 + 来源页码 + BM25 近似检索）
              │
              ▼
      Kimi API (https://api.moonshot.cn/v1)
```

## 快速开始

### 1. 配置 API Key

复制 `.env.example` 为 `.env`，填入你的 Kimi API Key：

```bash
# Windows PowerShell
copy .env.example .env
# 然后用记事本编辑 .env，填入 KIMI_API_KEY
```

### 2. 启动服务

```bash
cd backend
node --env-file=.env server.js
```

看到如下输出即成功：

```
=== 灵枢智训后端已启动 ===
  前端页面:  http://localhost:3000
  Kimi 模型: 以 .env 的 KIMI_MODEL 为准
```

> 没有 .env 文件时也可用 PowerShell 直接设置环境变量：
> `$env:KIMI_API_KEY="sk-xxx"; node server.js`

### 3. 打开网站

浏览器访问 **http://localhost:3000**

- 登录账号：`yejiaxin`　密码：`88888888`
- 聊天页：选择消费者画像，输入销售话术，消费者 Agent 实时回复
- 训练开场：先展示顾客背景卡片，由销售员主动发起对话
- 报告页：发送"结束训练并评分"，评分 Agent 生成四维评估报告，并在末尾给出有知识库依据的必背知识点

## API 说明

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/personas | 消费者画像列表 |
| POST | /api/chat | 消费者对话，body: `{sessionId, personaId, message}` |
| POST | /api/evaluate | 四维评分，body: `{sessionId, personaId, manual?}` |
| POST | /api/reset | 重置会话并返回顾客背景说明，body: `{sessionId, personaId, maxTurns?}` |

## 配置项（.env）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| KIMI_API_KEY | （可选） | 未配置时启用本地保守降级，正式演示建议配置 |
| KIMI_MODEL | kimi-k2.6 | Kimi 模型名称，可在 `.env` 覆盖 |
| KIMI_BASE_URL | https://api.moonshot.cn/v1 | OpenAI 兼容端点 |
| PORT | 3000 | 服务端口 |
| RATE_LIMIT_PER_MINUTE | 10 | 单个IP每分钟最多调用聊天/评分接口的次数 |

## 目录结构

```
backend/
├── server.js            # HTTP 服务 + 路由 + 会话状态
├── kimi.js              # Kimi API 客户端（OpenAI 兼容）
├── personas.js          # 12 个消费者画像配置
├── consumer-agent.js    # 消费者对话 Agent
├── evaluator-agent.js   # 评分 Agent + 确定性公式和封顶
├── rules.js             # 合规预检、状态增量、隐藏信息触发
├── knowledge.js         # 编号知识条目解析 + 检索
├── test.js              # 红线、检索、评分与前端语法测试
├── .env.example         # 环境变量模板
└── public/              # 前端静态资源（可选，默认用 ../output）
```

## 说明

- 会话状态存储在内存中，服务重启后重置
- 主知识库为 `../knowledge/复方阿胶浆产品知识库_评分Agent_2026.md`，来自三份 PDF 的审核版整理；原始 FAQ 仅作降级
- 合规风险指数越高越危险。综合分固定为：产品知识×25% + 异议应对×25% + (100−合规风险)×30% + 共情沟通×20%
- A 类红线或风险指数≥80 时综合分最高 40；风险指数 61—79 时最高 60
- `/api/chat` 与 `/api/evaluate` 按来源IP限流，默认每分钟合计10次；超限返回 HTTP 429
- 运行测试：`node test.js`
- 评分报告保存于浏览器 localStorage
