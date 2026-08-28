# Session State

## Current Goal

AI Session SDK: SQLite 本地持久化与 Markdown 知识库 RAG 检索

## Current Task

TASK-013：实现 Markdown/代码知识库、增量缓存与动态 RAG 检索

## Status

DONE

## Completed

- **SQLite 本地持久化（TASK-012）**：
  - 基于 Node.js 原生 `node:sqlite`（`DatabaseSync`）实现 `SQLiteStorage`，保持 0 运行时依赖；
  - 默认存储于 `./data/ai-session.db`，支持 WAL 并发模式与忙超时；
  - 提供会话 CRUD、文件元数据与 FTS5 虚拟全文索引管理。
- **本地 Markdown/代码知识库系统与 RAG（TASK-013）**：
  - 允许在 `system` / `systemContext` 中直接传入 `.md` 文件或目录路径；
  - 实现 Markdown 标题层级语义切片（`# H1/H2/H3`）、面包屑导航与全局大纲（TOC）生成；
  - 实现 TypeScript/JavaScript 代码骨架提取（保留类型、接口与函数签名，剥离函数体）；
  - 实现基于 `mtime` 和 `size` 的毫秒级增量变更检测，未变动文件 0ms 启动；
  - 实现基于 SQLite FTS5 的动态相关小节检索，默认不作强制硬编码截断以保留完整细节。
- **Provider 弹性重试**：
  - 内置 `fetchWithRetry`，对 429 限流与 503 超载自动执行指数退避重试。
- **测试与验证**：
  - 新增 `test/storage/sqlite-storage.test.ts`、`test/knowledge/knowledge-manager.test.ts`、`test/integration/knowledge-session.test.ts`；
  - 全量 16 个测试套件，82 个测试用例 100% 通过；
  - 编写 `examples/knowledge-base.ts` 并通过 NVIDIA NIM 真实模型多轮长会话实测验证；
  - 全面更新架构设计、决策记录（ADR-007 ~ ADR-010）、任务卡与 README 说明。

## Verification

已运行：
- `pnpm test`：16 个测试套件，82 个测试全部通过（100% Pass）。
- `pnpm run typecheck`：通过，严格无类型错误。
- `pnpm build`：成功构建（生成 ESM、CJS 及 .d.ts 声明文件）。
- 真实环境多轮会话实测：`examples/knowledge-base.ts`（结合 `.env.nvidia`）成功通过。

## Open Issues

- 无。所有规划功能均已完成并通过端到端验证。

## Next Task

- 用户可直接在业务代码或项目中导入使用，并随意准备知识库文件夹进行多轮问答。
