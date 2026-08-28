# TASK-008

## Objective

实现 Session Manager，使创建、加载、持续 Chat 和完整 History 持久化形成闭环。

## Scope

连接 AIClient、Provider、Storage 和 Session；实现 user/session 隔离、system context、用户/助手消息保存和恢复。

## Allowed Files

- `src/session/*`
- `src/client/*`
- `src/index.ts`
- `test/session/*`
- `test/client/*`

## Dependencies

TASK-004、TASK-005。

## Inputs and Outputs

输入：Storage 和 Provider 接口。输出：可创建/恢复并持续对话的 Session API。

## Acceptance Criteria

- 新 Session 能保存 system context 和消息。
- 同一 `userId + sessionId` 能恢复历史并继续请求。
- 不同用户不能读取或覆盖彼此 Session。
- Provider 失败时不追加虚假的 assistant 消息。

## Verification Commands

```bash
pnpm test -- session
pnpm build
```

## Risks and Assumptions

Context Compact 暂由后续 Task 接入；本 Task 可先发送完整或受限历史，但不得破坏 History。

## Status

DONE

