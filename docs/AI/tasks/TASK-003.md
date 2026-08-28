# TASK-003

## Objective

定义 Provider、Message、Session、Storage 所需的统一领域类型和接口契约。

## Scope

只建立可复用类型和接口，明确输入、输出、错误和异步约定；不实现 Memory Storage、Provider 或 Session 流程。

## Allowed Files

- `src/types/*`
- `src/storage/storage.ts`
- `src/provider/provider.ts`
- `src/index.ts`
- 类型测试文件

## Dependencies

TASK-002。

## Inputs and Outputs

输入：架构文档和已确定的包工具链。输出：稳定、可导入且可测试的核心接口。

## Acceptance Criteria

- 统一消息、请求、响应、Session 和 Provider 配置类型可从公共入口使用。
- Storage 接口覆盖 Session 保存、加载、更新、删除及按 `userId` 查询。
- Provider 接口不依赖 Session 或具体 Storage。
- 类型测试覆盖必填字段和可选字段的约束。

## Verification Commands

```bash
pnpm test
pnpm build
```

## Risks and Assumptions

Streaming 类型必须保留增量表达能力，但不提前承诺具体传输协议。

## Status

DONE

