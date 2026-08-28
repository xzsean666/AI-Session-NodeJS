# TASK-009

## Objective

实现 Context Manager、可测试的 token 估算、阈值判断和 Provider 无关的 Compact 流程。

## Scope

构建 system + summary + recent messages 的请求上下文，在接近限制时生成摘要并保留完整 History。

## Allowed Files

- `src/context/*`
- `src/compact/*`
- `src/session/*`（仅接入点）
- `test/context/*`
- `test/compact/*`

## Dependencies

TASK-008。

## Inputs and Outputs

输入：Session History、模型限制和统一 Provider。输出：可发送给 Provider 的 Context，以及更新后的 Summary。

## Acceptance Criteria

- 阈值以下只选取符合策略的上下文，不无界增长。
- 超过阈值时自动 Compact，并组合摘要与近期消息。
- Compact 不删除完整 History；失败保留原数据。
- token 估算和裁剪策略有边界测试。

## Verification Commands

```bash
pnpm test -- context
pnpm test -- compact
pnpm build
```

## Risks and Assumptions

精确 tokenizer 可能需要额外依赖；在引入前应证明现有策略不足并更新决策记录。

## Status

DONE

