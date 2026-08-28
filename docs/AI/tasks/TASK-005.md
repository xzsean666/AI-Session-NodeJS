# TASK-005

## Objective

定义统一 Provider 接口和跨协议的请求、响应、错误及基础 streaming 模型。

## Scope

固化 ProviderManager 可依赖的契约和协议选择方式；不调用真实外部 API。

## Allowed Files

- `src/provider/*`
- `src/types/*`
- `src/index.ts`
- Provider 契约测试文件

## Dependencies

TASK-003。

## Inputs and Outputs

输入：领域消息和 Provider 配置类型。输出：Provider 适配器的统一调用契约。

## Acceptance Criteria

- Provider 能接收统一请求并返回统一响应。
- `protocol` 和 `baseUrl` 能选择协议适配器，不把 URL 写死在 Session 中。
- 流式和非流式返回形式有明确类型。
- 网络、认证和协议错误可被统一识别。

## Verification Commands

```bash
pnpm test -- provider
pnpm build
```

## Risks and Assumptions

真实 API 字段差异由各适配器处理；统一模型只包含 MVP 必需信息。

## Status

DONE

