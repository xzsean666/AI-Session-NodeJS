# TASK-004

## Objective

实现默认的 Memory Storage，并验证 Session 数据隔离和基本 CRUD 行为。

## Scope

在 TASK-003 的 Storage 接口上实现内存存储；不实现数据库适配器或 Provider 调用。

## Allowed Files

- `src/storage/memory-storage.ts`
- `src/index.ts`
- `test/storage/*`

## Dependencies

TASK-003。

## Inputs and Outputs

输入：Storage 接口和 Session 类型。输出：可注入 AIClient/Session 的 Memory Storage。

## Acceptance Criteria

- 支持保存、加载、更新、删除和按 `userId` 查询。
- 相同 `sessionId` 在不同 `userId` 下互不覆盖。
- 未找到 Session 的行为明确且有测试。
- 返回值不会让调用方无意修改内部存储引用。

## Verification Commands

```bash
pnpm test -- storage
pnpm build
```

## Risks and Assumptions

Memory Storage 不承诺进程重启后保留数据，只作为默认开发实现。

## Status

DONE

