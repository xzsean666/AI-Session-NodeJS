# AI Session SDK 架构

## 1. 分层架构

```text
Application
    │
    ▼
AIClient
    │
    ├── Session ─────────────── Storage (默认: SQLiteStorage ./data/ai-session.db, 支持 MemoryStorage / 外部注入)
    │     │
    │     ├── KnowledgeManager ── [MarkdownChunker / CodeSkeleton] ── [SQLite FTS5 全文索引]
    │     │
    │     └── ContextManager ──── CompactStrategy (Token 预算与长会话摘要压缩)
    │                                  │
    │                                  ▼
    └────────────────────────── ProviderManager (带 fetchWithRetry 指数退避重试)
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                       OpenAI      Anthropic      Gemini
                  (兼容 NIM/OpenRouter/DeepSeek/vLLM)
```

`AIClient` 是应用入口；Session 负责对话生命周期；KnowledgeManager 负责本地知识库索引与动态 RAG 检索；ContextManager 负责当前请求的上下文投影与自动压缩；Provider 负责外部协议；Storage 负责持久化与全文索引。

## 2. 核心数据模型

### ProviderConfig

```text
protocol  API 协议类型，例如 openai、anthropic、gemini
baseUrl   API 地址，可指向官方、代理、NVIDIA NIM、OpenRouter 或自建服务
apiKey    认证信息
model     模型标识
```

### SessionData

```text
userId          上层业务提供的用户标识
sessionId       会话标识
systemContext   系统提示或系统上下文（支持动态知识库注入）
messages        完整历史消息（Message[]）
summary         最近一次 Compact 的摘要，可为空
metadata        扩展元数据
createdAt       创建时间戳
updatedAt       更新时间戳
```

### KnowledgeConfig

```text
path                Markdown 文档、代码文件或目录路径
prompt              前置系统人设提示词
mode                'rag' (默认, FTS5检索) | 'skeleton' (代码签名) | 'full' (全量)
maxKnowledgeTokens  可选注入上限（默认不设限，注入全部命中细节）
searchLimit         RAG 检索最大小节数（默认 15）
extensions          支持的文件后缀（.md, .ts, .js, .json, .txt 等）
ignore              忽略规则（node_modules, .git, dist, .env 等）
forceReindex        是否强制全量重建索引（默认 false，走增量检测）
```

## 3. Session 请求流程（含 RAG 动态注入）

```text
session.chat(input)
    │
    ├── 1. load Session by userId + sessionId (从 SQLite 或 Memory 中读取)
    ├── 2. append user message to complete History
    ├── 3. 若配置了 KnowledgeManager:
    │       ├── 检查目录文件 mtime 增量更新 SQLite 索引 (0ms cache hit)
    │       └── 基于当前提问从 SQLite FTS5 检索相关小节并生成 Dynamic System Prompt
    ├── 4. ContextManager 组装 system + summary + recent messages
    ├── 5. 检查 Context Token 预算:
    │       ├── 低于阈值: 直接继续
    │       └── 超过阈值: 通过统一 Provider 接口生成摘要 (Compact) 并更新 summary
    ├── 6. Provider 发送请求 (内置 fetchWithRetry 自动重试 429/503)
    ├── 7. append assistant response to complete History
    ├── 8. Storage (SQLite) 自动持久化更新后的 Session
    └── 9. 返回 response 或 stream
```

## 4. 知识库与本地 RAG 架构

- **Markdown 智能切片（Heading-Level Chunking）**：按 Markdown `# H1`、`## H2`、`### H3` 标题做语义切片，保留面包屑层级（如 `[01-order.md > 状态流转 > 规则2]`），并自动剥离 HTML 注释与图片链接噪音。
- **代码骨架化（Code Skeleton Extraction）**：自动提取 TypeScript/JavaScript 的 `interface`、`type` 与导出函数/类签名，移除函数体实现，降低 80% Token 占用。
- **SQLite 原生 FTS5 全文索引**：利用 SQLite 内置的 `ai_knowledge_fts` 虚拟表进行关键词与语义相关度检索，毫秒级响应。
- **毫秒级增量同步**：比对文件 `mtime` 和 `size`，未变动文件 0ms 启动，变更文件增量更新。

## 5. Storage 架构与 SQLite 本地持久化

- **默认实现 `SQLiteStorage`**：
  - 基于 Node.js 原生 `node:sqlite`（`DatabaseSync`），零外部依赖。
  - 默认存储于 `./data/ai-session.db`。
  - 开启 WAL 并发模式与忙超时（`PRAGMA busy_timeout = 5000`）。
  - 管理 `ai_sessions`、`ai_knowledge_files`、`ai_knowledge_chunks` 与 `ai_knowledge_fts` 四张表。
- **可替换性**：保留 `MemoryStorage` 用于纯内存单元测试，亦支持用户通过 `IStorage` 接口接入 Redis、PostgreSQL 等外部数据库。

## 6. Provider 架构与弹性重试

Provider 实现统一接口，负责协议转换，不感知 Session 与 Storage。
- **弹性重试（`fetchWithRetry`）**：针对 429 限流或 503 服务超载自动执行最多 2 次指数退避重试，提升复杂多轮会话稳定性。
- **OpenAI Compatible Provider**：支持标准 OpenAI、NVIDIA NIM、OpenRouter、DeepSeek、vLLM、LiteLLM 等。
- **Anthropic & Gemini Provider**：处理对应官方协议格式。

## 7. Context 与 Compact

History 记录完整事实，Context 是发给模型的临时视图。在多轮对话超出预算时自动摘要压缩旧对话，保留最近轮次（`keepRecentMessages`），实现单 Session 永久持续对话不爆 Token。

## 8. 包与公共 API

公共入口 `ai-session`（`src/index.ts`）统一导出：
- 客户端与核心：`AIClient`, `Session`
- 存储：`SQLiteStorage` (默认), `MemoryStorage`, `IStorage`
- 知识库：`KnowledgeManager`, `chunkMarkdown`, `extractMarkdownTOC`, `extractCodeSkeleton`
- 提供商：`OpenAICompatibleProvider`, `AnthropicProvider`, `GeminiProvider`
- 错误类型：`AISessionError`, `StorageError`, `SessionNotFoundError`, `ProviderError`, `RateLimitError`, `AuthenticationError`, `InvalidRequestError`
