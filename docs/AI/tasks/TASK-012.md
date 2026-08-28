# TASK-012：实现 SQLite 原生持久化存储 (SQLiteStorage) 与 FTS5 支持

## 状态

DONE

## 目标

利用 Node.js 原生 `node:sqlite`（Node >= 22.5.0）实现开箱即用的 `SQLiteStorage`，作为 `AIClient` 的默认持久化存储，无需任何外部 npm 依赖即可在本地持久化多用户、多 Session 的历史数据。

## 详细要求

1. **零外部依赖**：基于原生 `DatabaseSync` 实现，提供文件数据库（默认 `./data/ai-session.db`）与内存数据库（`:memory:`）支持。
2. **表结构设计**：
   - `ai_sessions`：存储会话 JSON 数据、时间戳与主键索引。
   - `ai_knowledge_files`：存储知识库文件元数据（路径、mtime、size、hash）。
   - `ai_knowledge_chunks`：存储分块片段与 Token 估算。
   - `ai_knowledge_fts`：基于 FTS5 的全文索引虚拟表。
3. **并发安全与鲁棒性**：启用 WAL 模式（`PRAGMA journal_mode = WAL;`）与忙超时（`PRAGMA busy_timeout = 5000;`），防止多线程/进程并发锁库。
4. **单元测试验证**：提供完整的 CRUD、异常处理、FTS5 匹配测试套件。

## 涉及文件

- `src/storage/sqlite-storage.ts`
- `src/client/ai-client.ts`
- `src/index.ts`
- `test/storage/sqlite-storage.test.ts`
