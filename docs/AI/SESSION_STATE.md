# Session State

## Current Goal

AI Session SDK: 多节点负载均衡下的 Session Pinning（会话亲和性与 API 端点锁定）

## Current Task

TASK-014：实现多节点负载均衡下的 Session Pinning（会话亲和性与 API 端点锁定）

## Status

DONE

## Completed

- **Session Pinning 会话亲和性与 API 端点锁定（TASK-014）**：
  - 在 `LoadBalancedProvider` 中新增 `pinnedSessions: Map<string, number>` 会话锁定映射机制；
  - 支持 `sessionAffinity: true`（或 `pinSession: true`）配置项，同一个 `sessionId` 的多次请求稳定命中同一健康 API 节点，最大化 Claude / DeepSeek / OpenAI / vLLM 的 Prefix / Prompt Cache 命中率；
  - 支持 `repinOnFailover` 故障自愈重绑：当被 Pin 的节点发生 429 限流或 5xx 故障时，自动 Failover 到备选节点并在请求成功后平滑重绑新健康节点；
  - 支持会话持久化亲和度恢复：`pinnedTarget` 随 `SessionData` 存入 SQLite / Memory 存储，跨服务重启与重新加载（`loadSession`）自动继承 API 绑定；
  - 提供丰富的管理接口：`session.getPinnedTarget()`、`session.getPinnedTargetInfo()`、`session.pinTarget(...)`、`session.unpinTarget()`，以及 Provider 级别的 `pinSession`、`unpinSession` 等；
  - 请求响应结果透明注入当前处理端点信息（`res.target` 与 `res.raw.target`）。
- **示例与测试**：
  - 更新 `examples/load-balance-and-cache.ts`，增加会话锁定与亲和分流演示；
  - 补充 `test/provider/load-balanced-provider.test.ts` 亲和性单测与 `test/integration/session-pinning.test.ts` 集成测试；
  - 全量 20 个测试套件，104 个测试用例 100% 全部通过。
- **文档与架构更新**：
  - 更新 `README.md`，增加 Feature 亮点与「负载均衡与会话锁定」实战章节；
  - 更新 `docs/AI/ARCHITECTURE.md` 负载均衡与亲和性架构设计；
  - 增加架构决策记录 `docs/AI/DECISIONS.md`（ADR-011）；
  - 建立任务说明 `docs/AI/tasks/TASK-014.md` 并更新 `docs/AI/TASK_INDEX.md`。

## Verification

已运行：
- `pnpm test`：20 个测试套件，104 个测试全部通过（100% Pass）。
- `pnpm run typecheck`：通过，严格无类型错误。
- `pnpm run build`：成功构建（生成 ESM、CJS 及 .d.ts 声明文件）。

## Open Issues

- 无。所有功能均已完成并通过端到端验证。

## Next Task

- 用户可直接在业务代码中使用 `sessionAffinity: true` 或 `session.pinTarget()` 享受高命中率的 Prompt Cache 体验。
