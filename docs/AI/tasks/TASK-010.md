# TASK-010

## Objective

把 streaming、Session 恢复和自动 Compact 组合成可验证的端到端 MVP 流程。

## Scope

验证多 Provider 中至少一个非流式和一个流式路径，检查应用重启后的 Storage 恢复，以及 Compact 后继续对话。

## Allowed Files

- `src/session/*`
- `src/context/*`
- `src/provider/*`
- `test/integration/*`
- 测试 fixtures 和直接相关配置

## Dependencies

TASK-006、TASK-007、TASK-009。

## Inputs and Outputs

输入：已完成的 Provider、Session、Context 和 Storage 模块。输出：集成测试与稳定的 MVP 行为。

## Acceptance Criteria

- streaming 增量可被消费，结束时得到完整 assistant 内容并持久化。
- 恢复流程能加载历史、摘要和 metadata。
- 自动 Compact 后能继续 Chat，且完整 History 可查询。
- 集成测试不依赖真实密钥；网络测试有明确隔离方式。

## Verification Commands

```bash
pnpm test -- integration
pnpm test
pnpm build
```

## Risks and Assumptions

并发 Chat、取消请求和重试策略若超出 MVP，应记录为新 Task，不在此扩大范围。

## Status

DONE

