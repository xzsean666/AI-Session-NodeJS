# AI Agent 项目规则

本文件是本仓库中 AI 开发代理的项目级工作约定。它补充系统和开发者指令，不覆盖更高优先级指令。

## 工作范围

- 一次只处理一个 Goal 和一个当前 Task。
- 每个 session 默认最多完成一个 Task。
- 只修改当前 Task 的允许文件；发现额外工作时新建 Task，不在当前 Task 中顺手实现。
- 保留用户已有修改，不执行 `git reset`、`git checkout`、递归删除或其他破坏性操作。
- 不主动提交、推送或发布。
- 不添加依赖，除非当前 Task 明确要求且现有能力不足。

## 开始 session

按以下顺序读取事实来源：

1. 确认项目根目录并检查 `git status --short`。
2. 读取仓库规则文件（如 `AGENTS.md`、`CONTRIBUTING.md`）。
3. 读取 `docs/AI/GOAL.md`、`docs/AI/TASK_INDEX.md`、`docs/AI/SESSION_STATE.md`。
4. 读取当前 Task 及其直接相关的源码、测试和配置。
5. 检查当前 Task 的依赖和允许修改范围。
6. 在修改前输出执行计划。

如果没有依赖已满足的 Task，说明阻塞原因，不跳过依赖。

## 实现与验证

- 遵循已有语言、包管理器、命名、错误处理、日志和测试约定。
- 保持 Provider、Session、Context、Storage 的依赖方向稳定。
- 先运行最窄的相关验证，再根据风险运行更广的检查。
- 只报告实际运行过的命令和结果。
- 测试失败时区分代码回归、既有失败、环境问题和未确定原因。

## session 交接

结束前必须更新 `docs/AI/SESSION_STATE.md`，记录当前 Goal、Task、状态、已完成内容、修改文件、验证结果、风险、未解决问题和下一步。

