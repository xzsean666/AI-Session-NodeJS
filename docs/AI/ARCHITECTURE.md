# AI Session SDK 架构

## 1. 分层架构

```text
Application
    │
    ▼
AIClient (支持 options.cache 响应缓存 / options.storageCache 内存缓存)
    │
    ├── Session ─────────────── Storage (CachedStorage L1 内存 LRU ── SQLiteStorage / MemoryStorage)
    │     │
    │     ├── KnowledgeManager ── [MarkdownChunker / CodeSkeleton] ── [SQLite FTS5 全文索引 (0ms mtime cache)]
    │     │
    │     └── ContextManager ──── CompactStrategy (Token 预算与长会话摘要压缩)
    │                                  │
    │                                  ▼
    └────────────────────────── Provider 层 (CachedProvider 响应缓存)
                                       │
                                       ▼
                              LoadBalancedProvider (多 Key / 多 URL 负载均衡 + 429 冷却 + 故障重试)
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                       OpenAI      Anthropic      Gemini
                  (兼容 NIM/OpenRouter/DeepSeek/vLLM)
```

`AIClient` 是应用入口；Session 负责对话生命周期；KnowledgeManager 负责本地知识库索引与动态 RAG 检索；ContextManager 负责当前请求的上下文投影与自动压缩；LoadBalancedProvider 负责多节点与多密钥分流与容灾；CachedProvider 与 CachedStorage 负责响应与存储两级缓存加速；Storage 负责持久化与全文索引。

## 2. 核心数据模型

### ProviderConfig / LoadBalancedProviderOptions

```text
protocol     API 协议类型，例如 openai、anthropic、gemini
baseUrl      单个 API 地址
baseUrls     多个 API 镜像节点地址列表（用于负载均衡与故障容灾）
apiKey       单个认证密钥
apiKeys      多个认证密钥列表（用于多账号配额轮询分流）
targets      完整端点列表（Array<{ baseUrl, apiKey, weight, headers }>）
loadBalance  负载均衡策略配置（strategy: 'round-robin' | 'random' | 'weighted', cooldownMs, maxRetries）
model        模型标识
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

## 3. Session 请求流程（含 RAG 与两级缓存）

```text
session.chat(input)
    │
    ├── 1. load Session by userId + sessionId
    │       ├── L1 内存缓存命中: 0ms 立即返回
    │       └── L1 未命中: 从 SQLite 读取并回填 L1 缓存
    ├── 2. append user message to complete History
    ├── 3. 若配置了 KnowledgeManager:
    │       ├── 检查目录文件 mtime 增量更新 SQLite 索引 (0ms cache hit)
    │       └── 基于当前提问从 SQLite FTS5 检索相关小节并生成 Dynamic System Prompt
    ├── 4. ContextManager 组装 system + summary + recent messages
    ├── 5. 检查 Context Token 预算:
    │       ├── 低于阈值: 直接继续
    │       └── 超过阈值: 通过统一 Provider 接口生成摘要 (Compact) 并更新 summary
    ├── 6. Provider 层处理:
    │       ├── CachedProvider 检查响应缓存:
    │       │     └── 命中: 直接返回或回放流 (0 Token 消耗)
    │       └── 未命中: LoadBalancedProvider 路由到健康节点:
    │             ├── 依据策略 (Round-Robin / Random / Weighted) 选择端点
    │             ├── 遇到 429 RateLimit: 标记该节点冷却 (默认 30s) 并自动 Failover 切换下一节点
    │             └── 遇到 5xx/网络故障: 自动切换到下一个可用节点重试
    ├── 7. append assistant response to complete History
    ├── 8. Storage (CachedStorage + SQLite) 持久化更新后的 Session
    └── 9. 返回 response 或 stream
```

## 4. 负载均衡与高可用架构 (Load Balancing & Failover)

- **`LoadBalancedProvider` 核心能力**：
  - **灵活输入规范化**：支持单 URL 多 Key、多 URL 单 Key、多 URL 多 Key 以及精细化的 `targets` / `endpoints` 节点列表。
  - **单模型家族聚合与中转容灾**：面向单一模型系列（如 OpenAI 模型族、NVIDIA NIM 模型族），统一管理官方直连端点、多个中转 API（Relay API）与聚合服务（OpenRouter 等），支持 target 级别模型标识覆盖。
  - **多种调度算法**：
    - `priority`（主备容灾模式）：始终优先第一条主力线路（如官方直连），遇到 429、5xx 或网络超时自动毫秒级降级至备用中转 API，主线路冷却期过后自动切回。
    - `round-robin`（默认轮询）：在可用健康节点中依次轮流分配请求。
    - `random`（随机分流）：在当前健康节点中随机抽取。
    - `weighted`（加权随机）：根据节点 `weight` 权重分配流量比例。
  - **429 限流主动冷却（Rate Limit Cooldown）**：
    - 当某 Key / 节点遭遇 429 频控限制时，自动打上冷却时间戳（默认 30 秒），冷却期内不再分配流量。
  - **会话亲和与端点锁定（Session Pinning & Sticky Session）**：
    - **Prompt / Prefix Cache 极致优化**：现代 LLM（Claude Prompt Caching, DeepSeek Prefix Caching, OpenAI Prompt Caching, vLLM PagedAttention）在多次对话打向同一节点时，能最大化命中 KV Cache，将 TTFT 延迟降低 80%+ 并节省 50%~90% Prompt Tokens 费用。
    - **自动亲和分配与锁定**：开启 `sessionAffinity: true`（或 `loadBalance.sessionAffinity: true`）时，系统通过负载均衡策略（如 round-robin）为新 Session 分配健康的 API 节点并自动锁定；后续该 Session 的所有 `chat` / `chatStream` 请求严格路由到该绑定节点。
    - **容灾自动重新绑定（Failover & Re-pinning）**：若被绑定的节点遭遇 429 限流或 5xx 故障，系统自动触发故障转移选出下一个健康节点重试，并在调用成功后将 Session 重新绑定（Re-pin）至新节点，保障高可用。
    - **持久化亲和度恢复**：Session 被绑定的节点信息会随 `SessionData.pinnedTarget` 持久化到 SQLite 等存储中，进程重启或通过 `client.loadSession()` 重新加载时，自动继承并激活原节点的亲和锁定。
    - **显式控制接口**：提供 `session.pinTarget(...)`、`session.unpinTarget()` 与 `session.getPinnedTargetInfo()`，允许业务按需手动锁定或解除绑定。
  - **无感动态热更新（Hot-Swapping Keys & URLs）**：
    - 提供 `provider.updateTargets(...)` 与 `provider.addTarget(...)` 方法，支持运行时在线轮换 API Key 与 Base URL，正在进行的会话、消息上下文与两级缓存均不受任何影响。

## 5. 多级缓存架构 (Multi-Tier Caching)

1. **响应级精确匹配缓存 (`ResponseCache` / `CachedProvider`)**：
   - 基于 `sha256(protocol, model, system, temperature, messages)` 计算确定性指纹。
   - 内置高性能 LRU 淘汰与 TTL 自动过期机制。
   - 相同问答直接 0ms 响应，0 Token 费用；支持流式响应透明回放。
   - 可通过 `options.cache: true` 一键开启，亦支持请求级别 `customOptions: { noCache: true }` 动态绕过。
2. **会话存储 L1 内存缓存 (`CachedStorage`)**：
   - 包装底层持久化存储（如 `SQLiteStorage`），在进程内存中维护热点活跃 Session 的 LRU 缓存。
   - 读会话直接从内存读取并深拷贝，避免重复的磁盘 I/O 与 JSON 反序列化开销。
   - 通过 `options.storageCache: true` 一键开启。
3. **知识库增量扫描缓存**：
   - 基于文件 `mtime` 和 `size` 比对，启动时对无变动文件 0ms 命中，免除重复切片和 FTS5 重建。

## 6. 知识库与本地 RAG 架构

- **Markdown 智能切片（Heading-Level Chunking）**：按 Markdown `# H1`、`## H2`、`### H3` 标题做语义切片，保留面包屑层级（如 `[01-order.md > 状态流转 > 规则2]`），并自动剥离 HTML 注释与图片链接噪音。
- **代码骨架化（Code Skeleton Extraction）**：自动提取 TypeScript/JavaScript 的 `interface`、`type` 与导出函数/类签名，移除函数体实现，降低 80% Token 占用。
- **SQLite 原生 FTS5 全文索引**：利用 SQLite 内置的 `ai_knowledge_fts` 虚拟表进行关键词与语义相关度检索，毫秒级响应。
- **毫秒级增量同步**：比对文件 `mtime` 和 `size`，未变动文件 0ms 启动，变更文件增量更新。

## 7. Storage 架构与 SQLite 本地持久化

- **默认实现 `SQLiteStorage`**：
  - 基于 Node.js 原生 `node:sqlite`（`DatabaseSync`），零外部依赖。
  - 默认存储于 `./data/ai-session.db`。
  - 开启 WAL 并发模式与忙超时（`PRAGMA busy_timeout = 5000`）。
  - 管理 `ai_sessions`、`ai_knowledge_files`、`ai_knowledge_chunks` 与 `ai_knowledge_fts` 四张表。
- **可替换性**：保留 `MemoryStorage` 用于纯内存单元测试，亦支持用户通过 `IStorage` 接口接入 Redis、PostgreSQL 等外部数据库。

## 8. Provider 架构与弹性重试

Provider 实现统一接口，负责协议转换，不感知 Session 与 Storage。
- **弹性重试（`fetchWithRetry`）**：针对 429 限流或 503 服务超载自动执行最多 2 次指数退避重试，提升复杂多轮会话稳定性。
- **OpenAI Compatible Provider**：支持标准 OpenAI、NVIDIA NIM、OpenRouter、DeepSeek、vLLM、LiteLLM 等。
- **Anthropic & Gemini Provider**：处理对应官方协议格式。

## 9. Context 与 Compact

History 记录完整事实，Context 是发给模型的临时视图。在多轮对话超出预算时自动摘要压缩旧对话，保留最近轮次（`keepRecentMessages`），实现单 Session 永久持续对话不爆 Token。

## 10. 包与公共 API

公共入口 `ai-session`（`src/index.ts`）统一导出：
- 客户端与核心：`AIClient`, `Session`
- 存储与缓存：`SQLiteStorage` (默认), `MemoryStorage`, `CachedStorage`, `IStorage`
- 响应缓存：`ResponseCache`, `CachedProvider`
- 知识库：`KnowledgeManager`, `chunkMarkdown`, `extractMarkdownTOC`, `extractCodeSkeleton`
- 提供商与负载均衡：`OpenAICompatibleProvider`, `AnthropicProvider`, `GeminiProvider`, `LoadBalancedProvider`, `normalizeEndpointTargets`
- 错误类型：`AISessionError`, `StorageError`, `SessionNotFoundError`, `ProviderError`, `RateLimitError`, `AuthenticationError`, `InvalidRequestError`
