# 灵枢智训——复方阿胶浆销售训练智能体

面向复方阿胶浆销售人员的消费者模拟与四维评价演示网站。

## 功能

- 12类消费者画像和多轮压力对话
- 隐藏信息、异议状态和自动停止机制
- 59个可追溯产品知识条目
- 顾客背景卡片开场，由销售员主动发起对话
- 报告末尾输出与本轮表现相关、可直接复习的必背知识点
- 产品知识、异议应对、合规风险、共情沟通四维评分
- 单个IP每分钟最多10次聊天/评分请求
- Kimi不可用时提供本地保守降级

## 本地运行

```powershell
cd backend
Copy-Item .env.example .env
# 编辑 .env，填写 KIMI_API_KEY
node --env-file=.env server.js
```

打开 `http://localhost:3000`。

## 测试

```powershell
node backend/test.js
```

## Render部署

仓库已包含 `render.yaml`。在Render中创建Blueprint并连接本仓库，然后在环境变量中填写`KIMI_API_KEY`。不要把`.env`或API密钥提交到GitHub。

## 使用边界

本项目仅用于销售培训模拟，不提供诊断、处方或个体用药建议，请勿输入真实患者隐私信息。
