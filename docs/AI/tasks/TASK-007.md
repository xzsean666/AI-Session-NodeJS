# TASK-007

## Objective

实现 Anthropic 和 Gemini Provider，并将其接入统一 ProviderManager。

## Scope

处理两种协议的 system、messages、模型、认证、响应和基础 streaming 差异；不修改 Session/Storage。

## Allowed Files

- `src/provider/anthropic.ts`
- `src/provider/gemini.ts`
- `src/provider/provider-manager.ts`
- `src/index.ts`
- `test/provider/anthropic/*`
- `test/provider/gemini/*`

## Dependencies

TASK-005。

## Inputs and Outputs

输入：统一 Provider 契约。输出：按 `protocol` 创建适配器的 ProviderManager。

## Acceptance Criteria

- 两个适配器都支持配置的 `baseUrl`、`apiKey` 和 `model`。
- system 和对话消息映射符合各自协议。
- 错误和 streaming 行为符合统一接口。
- ProviderManager 对不支持的 protocol 返回明确错误。

## Verification Commands

```bash
pnpm test -- anthropic
pnpm test -- gemini
pnpm build
```

## Risks and Assumptions

具体协议字段应以实现时的官方文档和锁定的客户端能力为准，并记录变更依据。

## Status

DONE

