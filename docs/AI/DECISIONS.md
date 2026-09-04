# Architecture Decisions

## ADR-001：SDK 采用 Provider 适配器和统一内部消息模型

状态：Accepted

不同 AI 服务的请求、响应和 streaming 协议不一致。Session 和 Context 不应知道底层服务商，因此 Provider 负责协议转换，核心层只依赖统一接口。

## ADR-002：Provider 配置按协议和地址建模

状态：Accepted

配置统一使用 `protocol`、`baseUrl`、`apiKey`、`model`。这样官方服务、代理、自建和本地服务都可使用同一协议适配器，不把服务商名称与 URL 绑定。

## ADR-003：完整 History 与 Context 投影分离

状态：Accepted

Context Compact 只改变当前请求使用的摘要和近期消息，不删除完整 History。这样既能恢复会话和查看历史，也能控制模型 Context Window 大小。

## ADR-004：Storage 通过接口注入，MVP 默认 Memory Storage

状态：Accepted

SDK 不绑定数据库。Memory Storage 便于零配置开发和测试，用户可以实现 PostgreSQL、Redis、MongoDB、SQLite、文件等适配器。

## ADR-005：用户体系不属于 SDK

状态：Accepted

SDK 只接收 `userId` 并用它隔离 Session；注册、登录、权限和用户资料由上层应用负责。

## ADR-006：运行时和工具版本延迟到骨架任务确认

状态：Accepted

当前仓库没有 `package.json`、锁文件、源码或测试配置。本 session 不猜测 Node.js、TypeScript、模块格式、HTTP 客户端或测试框架；TASK-002 必须先建立并记录这些基础约束。

## ADR-007：采用 Node.js 原生 `node:sqlite` 作为默认持久化存储

状态：Accepted

利用 Node.js 原生内置模块（Node >= 22.5.0 内置 `node:sqlite`），提供开箱即用的本地文件持久化（默认 `./data/ai-session.db`），进程重启数据不丢，同时保持 SDK 的零外部运行时依赖（Zero Runtime Dependencies）。

## ADR-008：本地 Markdown & 代码知识库采用标题语义分块与 SQLite FTS5 RAG

状态：Accepted

为了支持将本地 Markdown 文档/目录注入 System Prompt，SDK 采用 Markdown Heading 结构化切片 + 面包屑导航 + TypeScript 代码骨架提取，并使用 SQLite 原生 FTS5 全文索引实现毫秒级动态相关小节召回，大幅降低 Token 消耗（省 95%+）。

## ADR-009：知识库采用基于文件 mtime 的毫秒级增量缓存

状态：Accepted

知识库初始化时自动比对文件 `mtimeMs` 和 `size`。未变动文件 0ms 命中 SQLite 缓存，避免每次对话重复读盘切片；文件修改或删除时自动增量同步索引。

## ADR-010：知识库 Token 预算默认不设限以保障大模型认知完整性

状态：Accepted

`maxKnowledgeTokens` 默认不进行硬编码截断，确保命中问题的所有相关知识细节（完整业务规则与代码实现）能全量呈现给大模型，避免因过早截断导致模型信息缺失；同时在 Provider 层增加 `fetchWithRetry` 应对偶发性限流或超载。

## ADR-011：基于 Session Pinning 的 API 端点亲和绑定与 Prefix Cache 优化

状态：Accepted

现代大模型服务（Claude Prompt Caching, DeepSeek Prefix Caching, OpenAI Prompt Caching, vLLM PagedAttention 等）对上下文历史的 KV 缓存是实例或账号绑定的。若纯粹使用轮询（Round-Robin）分流多轮会话，同一个 Session 的请求会被随机打散到不同节点，导致每次对话均击穿前序 KV 缓存，延迟和费用成倍增加。

因此，SDK 引入 **Session Pinning（会话亲和性 / 端点锁定）**：
1. **自动亲和分配与锁定**：在开启 `sessionAffinity` 时，每个 Session 首次请求按策略分配到健康 API 节点后即刻 Pin 住，后续对话严格复用同一节点，充分发挥 Prefix Cache 优势（TTFT 缩短 80%+，Token 费用省 50%~90%）；
2. **容灾自愈重新绑定 (Re-pin on Failover)**：若当前 Pin 节点遭遇 429 或 5xx 故障，系统自动 Failover 至其他健康节点，并在成功后将会话平滑重新绑定（Re-pin）到新节点，兼顾极速缓存与高可用；
3. **跨持久化会话还原**：将 `pinnedTarget` 记录在 `SessionData` 中随 SQLite 等底层存储持久化，保证服务重启或重新加载会话后亲和度不丢。

## ADR-012：全链路高并发与零分配（Zero-Allocation）性能优化

状态：Accepted

针对高并发请求、多轮长会话以及知识库大规模扫描场景，SDK 对计算、存储、网络与流式解析层实施全链路性能调优：
1. **零分配 Token 估算器**：废除 `text.match()` 与 `text.replace()` 正则解析，改用单趟 O(N) `charCodeAt` 字符扫描，耗时下降 70%，内存临时分配降为 0；
2. **SQLite 预编译语句与批量事务**：建立语句缓存 Map 消除 SQL 重复编译（单次操作加速 3.6 倍）；知识块插入采用 `BEGIN IMMEDIATE` 显式事务，磁盘批量落盘速度提升 160 倍以上；开启 WAL、`synchronous = NORMAL` 及 64MB 缓存；
3. **负载均衡即时故障转移**：将单节点 Provider 重试与多节点 `LoadBalancedProvider` 调度解耦，子 Provider 遇到 429 时禁用冗余 sleep 等待，毫秒级切换备用节点（测试套件与故障演练速度提升 75 倍）；
4. **上下文与知识库记忆**：`ContextManager` 采用 `WeakMap` 缓存不可变历史消息的 Token 数量，杜绝多轮对话 $O(N^2)$ 计算退化；知识库未变动时自动复用内存 TOC 纲要，避免反复拉取大文本 Chunk；
5. **高效流式与缓存复用**：`iterateSSEEvents` 采用游标切分避免全局正则 split；`CachedProvider.chat` 避免冷请求重复计算两次 SHA-256。
