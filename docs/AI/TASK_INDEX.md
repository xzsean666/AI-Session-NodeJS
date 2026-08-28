# Task Index

任务状态只允许按 `TODO -> IN_PROGRESS -> REVIEW -> DONE` 变化；无法继续且缺少必要外部条件时使用 `BLOCKED`。

| Task | 目标 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [TASK-001](tasks/TASK-001.md) | 建立 AI 项目文档基线 | 无 | DONE |
| [TASK-002](tasks/TASK-002.md) | 建立 Node.js/TypeScript 包骨架和公共入口 | TASK-001 | DONE |
| [TASK-003](tasks/TASK-003.md) | 定义统一领域类型和 Storage 接口 | TASK-002 | DONE |
| [TASK-004](tasks/TASK-004.md) | 实现 Memory Storage 及其测试 | TASK-003 | DONE |
| [TASK-005](tasks/TASK-005.md) | 定义 Provider 接口和统一请求/响应模型 | TASK-003 | DONE |
| [TASK-006](tasks/TASK-006.md) | 实现 OpenAI Compatible Provider | TASK-005 | DONE |
| [TASK-007](tasks/TASK-007.md) | 实现 Anthropic 和 Gemini Provider | TASK-005 | DONE |
| [TASK-008](tasks/TASK-008.md) | 实现 Session Manager 和完整 History 流程 | TASK-004, TASK-005 | DONE |
| [TASK-009](tasks/TASK-009.md) | 实现 Context Manager、Token 估算和 Compact | TASK-008 | DONE |
| [TASK-010](tasks/TASK-010.md) | 集成 Streaming、恢复流程和端到端验证 | TASK-006, TASK-007, TASK-009 | DONE |
| [TASK-011](tasks/TASK-011.md) | 完成 Git 安装、README、示例和发布前检查 | TASK-010 | DONE |
| [TASK-012](tasks/TASK-012.md) | 实现 SQLite 原生持久化存储 (SQLiteStorage) 与 FTS5 支持 | TASK-004, TASK-011 | DONE |
| [TASK-013](tasks/TASK-013.md) | 实现 Markdown/代码知识库、增量缓存与动态 RAG 检索 | TASK-012 | DONE |

全部任务均已完成并通过全量验证。
