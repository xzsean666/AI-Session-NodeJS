# TASK-001

## Objective

建立 AI Session SDK 的项目级文档基线，使后续 session 能根据明确的 Goal、架构边界和任务依赖继续开发。

## Scope

整理用户提供的 MVP 目标、Provider/Session/Context/Storage 架构、关键决策、后续实现任务和 session 交接规则。

## Allowed Files

- `docs/AI_AGENT_PROMPT.md`
- `docs/AI/GOAL.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/ARCHITECTURE.md`
- `docs/AI/DECISIONS.md`
- `docs/AI/tasks/TASK-001.md`
- `docs/AI/tasks/TASK-002.md`
- `docs/AI/tasks/TASK-003.md`
- `docs/AI/tasks/TASK-004.md`
- `docs/AI/tasks/TASK-005.md`
- `docs/AI/tasks/TASK-006.md`
- `docs/AI/tasks/TASK-007.md`
- `docs/AI/tasks/TASK-008.md`
- `docs/AI/tasks/TASK-009.md`
- `docs/AI/tasks/TASK-010.md`
- `docs/AI/tasks/TASK-011.md`

## Dependencies

无。仓库为空项目骨架，本 Task 的结果是为后续 Task 建立依赖入口。

## Inputs and Outputs

输入：用户提供的 AI Session SDK 架构和 MVP 说明。

输出：可导航的 AI 文档目录，以及带依赖关系的后续 Task 清单。

## Acceptance Criteria

- Goal 明确 MVP 能力、非目标、用户体验目标和完成定义。
- Architecture 明确模块职责、数据关系、请求流程和依赖方向。
- Decisions 记录 Provider 解耦、History/Context 分离、Storage 注入和用户边界。
- Task Index 至少列出包骨架、领域类型、Storage、Provider、Session、Context/Compact、Streaming/集成和 Git 安装文档任务。
- 当前 Task 和下一 Task 的状态、依赖、允许文件、验收标准、验证命令齐全。
- `SESSION_STATE.md` 能让下一 session 在不重复探索的情况下恢复。

## Verification Commands

```bash
find docs -type f -print | sort
rg -n "TASK-001|TASK-002|MVP|Provider|Storage|Compact" docs/AI
git diff --check
git status --short
```

## Risks and Assumptions

- 文档使用用户给出的目标 API 作为方向性示例，不把尚未实现的字段当作稳定公共契约。
- 当前没有远端 URL、包名或 Node 工具链，Git 安装和构建命令需在后续任务落地后验证。

## Status

DONE
