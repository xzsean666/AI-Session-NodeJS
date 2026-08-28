# Goal: AI Session SDK MVP

## Objective

构建一个可通过 Git 依赖安装的 Node.js/TypeScript AI Session SDK。应用只需提供 AI Provider 配置、`userId` 和 `sessionId`，即可获得可持续、可恢复、自动保存历史并支持自动 Context Compact 的统一对话能力。

## 核心能力范围

### 第一阶段（基础核心）
- 多 AI Provider 接入和统一 Chat API（OpenAI / Anthropic / Gemini / NVIDIA NIM / OpenRouter / DeepSeek / 本地模型）
- 自定义 `baseUrl`、`apiKey`、`model` 和 `protocol`
- System Prompt / System Context
- 按 `userId` 隔离数据的 Session
- 完整 History、Session 恢复和持续对话
- Context Window 管理、Token 预算监控和自动 Compact 摘要压缩
- 基础 Streaming 流式对话支持与响应自动入库

### 第二阶段（存储升级与本地知识库 RAG）
- **默认内置 SQLite 本地持久化**：使用 Node.js 原生 `node:sqlite`（零外部运行时依赖），默认存储于 `./data/ai-session.db`。
- **Markdown & 代码知识库系统**：`system` 支持直接传入 `.md` 文件或知识库目录，自动解析层级标题（`# H1/H2/H3`）、生成面包屑导航与全局大纲（TOC）。
- **SQLite 原生 FTS5 全文检索（RAG）**：对话时根据提问动态召回最相关的知识小节，大幅节省 Token（省 95%+），且不对知识做强制硬编码截断。
- **毫秒级增量变更检测**：基于文件 `mtime` 和 `size` 毫秒级比对，未变动文件 0ms 命中 SQLite 缓存，有变动自动增量重构索引。
- **弹性重试（Resilient Retry）**：内置指数退避重试，自动抵御上游大模型偶发的 503 超载或 429 限流。

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

