# TASK-006

## Objective

实现 OpenAI Compatible Provider，支持官方、代理和自建兼容服务。

## Scope

完成非流式 Chat 和基础 streaming 的请求转换、认证、响应解析及错误处理；不实现 Session 或 Compact。

## Allowed Files

- `src/provider/openai-compatible.ts`
- `src/provider/http/*`（如确有需要）
- `test/provider/openai-compatible/*`
- `src/index.ts`

## Dependencies

TASK-005。

## Inputs and Outputs

输入：统一 Provider 契约和 OpenAI-compatible 服务配置。输出：可注入 Provider 实例。

## Acceptance Criteria

- `baseUrl` 可配置，不能依赖固定官方 URL。
- API key 通过约定的认证头发送，消息和模型正确映射。
- 非 2xx、无效响应和流中断有可识别错误。
- 使用 mock HTTP 的测试不依赖真实 API key 或网络。

## Verification Commands

```bash
pnpm test -- openai-compatible
pnpm build
```

## Risks and Assumptions

不同兼容服务的扩展字段暂不纳入 MVP，必要扩展应通过配置或后续 Task 增加。

## Status

DONE

