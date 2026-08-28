# Goal: AI Session SDK MVP

## Objective

构建一个可通过 Git 依赖安装的 Node.js/TypeScript AI Session SDK。应用只需提供 AI Provider 配置、`userId` 和 `sessionId`，即可获得可持续、可恢复、自动保存历史并支持自动 Context Compact 的统一对话能力。

## MVP 范围

第一阶段包含：

- 多 AI Provider 接入和统一 Chat API
- 自定义 `baseUrl`、`apiKey`、`model` 和 `protocol`
- System Prompt / System Context
- 按 `userId` 隔离数据的 Session
- 完整 History、Session 恢复和持续对话
- Context Window 管理、阈值检查和自动 Compact
- 可替换的 Storage 抽象，默认提供 Memory Storage
- 基础 Streaming 支持

首个 MVP 不包含：

- Tool Calling、MCP、Agent、多 Agent
- RAG、Embedding、Web Search
- Vision、Structured Output
- 用户注册、登录、权限和用户资料
- 复杂计费系统

## 用户体验目标

目标 API 形态如下。具体命名和返回类型以实现 Task 的契约为准：

```ts
const ai = new AIClient({
  provider: {
    protocol: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: process.env.AI_API_KEY,
    model: "model-name"
  }
});

const session = ai.session({
  userId: "user_001",
  sessionId: "session_001",
  system: "You are a helpful assistant."
});

const reply = await session.chat("你好");
```

应用重启后，使用同一组 `userId` 和 `sessionId` 应能加载历史并继续对话。SDK 不拥有用户系统，只接收并使用 `userId`。

## 非目标与边界

- Provider 负责协议适配，不负责 Session 持久化或 Context 裁剪。
- Storage 负责 Session、History、Summary 和 Metadata 的读写，不负责 AI 请求。
- History 保留完整记录；Context 是当前请求的投影，Compact 不应破坏完整历史。
- SDK 不假设 API 一定来自官方服务商；OpenAI Compatible Provider 应支持代理、自建服务和本地模型服务。

## 完成定义

MVP 完成时，核心流程应能闭环：创建 Session -> Chat -> 保存消息 -> 构建 Context -> 必要时 Compact -> 继续 Chat -> 通过 `userId + sessionId` 恢复。每个流程都有自动化测试或明确的手动验证方法，且可通过 pnpm 从 Git 安装并导入公共入口。

