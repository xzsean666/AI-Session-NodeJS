# TASK-014: 多节点负载均衡下的 Session Pinning（会话亲和性与 API 端点锁定）

## 状态
- 状态：DONE
- 负责人：Antigravity
- 依赖：TASK-008, TASK-011

## 目标
在大模型连接池与多 API URL / 多 API Key 负载均衡架构中，实现会话亲和性（Session Pinning / Sticky Session），将同一 `sessionId` 的多次请求固定路由到同一个健康 API 节点，最大化大模型服务端 Prefix Cache / Prompt Cache（KV Cache）命中率，大幅缩短首字延迟（TTFT 缩短 80%+）并节省 50%~90% Token 成本；同时具备 429 与 5xx 故障自动转移与重新绑定（Failover & Re-pinning）能力，且支持会话持久化亲和度恢复与手动锁定。

## 涉及模块与改动
1. **类型层 (`src/types/provider.ts`, `src/types/session.ts`)**：
   - 增加 `TargetInfo` 接口（回显 `index`, `baseUrl`, `protocol`, `model`）；
   - `LoadBalanceOptions` 增加 `sessionAffinity?: boolean`, `pinSession?: boolean`, `repinOnFailover?: boolean`；
   - `ProviderChatRequest` 扩展 `sessionId?: string`, `userId?: string`, `pinnedTarget?: number | string | EndpointTarget`；
   - `ProviderChatResponse` 与 `ProviderChunkResponse` 扩展 `target?: TargetInfo`；
   - `SessionData` 与 `SessionOptions` 扩展 `pinnedTarget` 与 `pinSession` 字段。
2. **Provider 层 (`src/provider/load-balanced-provider.ts`)**：
   - 内部维护 `pinnedSessions: Map<string, number>` 亲和映射；
   - 实现 `findTargetIndex(matcher)`、`pinSession(sessionId, target)`、`unpinSession(sessionId)`、`getPinnedTarget(sessionId)`、`getPinnedTargetIndex(sessionId)` 等管理方法；
   - `selectTargetIndex` 支持优先级选取：显式覆盖 > 已有 Pin 节点 > 策略新分配并自动 Pin；
   - 遭遇 429 RateLimit 或 5xx 时自动 Failover 到备选健康节点，并在成功后自动执行 `repinOnFailover` 重新绑定；
   - 每次请求成功在 `res.target` 与 `res.raw` 中透明注入当前响应的端点信息。
3. **Session 层 (`src/session/session.ts`)**：
   - 会话恢复（`ensureLoaded`）时自动从存储中读取历史 `pinnedTarget` 并激活亲和绑定；
   - 请求时自动向 Provider 注入 `sessionId` 与 `pinnedTarget`；
   - 提供 `session.getPinnedTarget()`、`session.getPinnedTargetInfo()`、`session.pinTarget(...)`、`session.unpinTarget()` 显式控制能力；
   - 每次交互成功后更新持久化存储中的 `sessionData.pinnedTarget`，确保跨进程重启亲和度不丢失。
4. **Client 层 (`src/client/ai-client.ts`)**：
   - `AIClientOptions` 支持 `sessionAffinity?: boolean` 全局亲和开关；
   - 创建会话时自动透传并绑定端点配置；
   - `loadSession` 时自动还原已绑定的 API 端点。

## 验证
- 编写 `test/provider/load-balanced-provider.test.ts` 单元测试，覆盖单会话固定路由、多会话负载分散、429 容灾自动切换与 Re-pin、显式 pinSession 与 unpinSession、流式传输 target 回显；
- 编写 `test/integration/session-pinning.test.ts` 集成测试，验证 AIClient 级会话锁定、SQLite 持久化与跨重启还原、与 ResponseCache 缓存协同工作；
- 运行 `pnpm test`：全部 20 个测试套件，104 个测试用例 100% 通过；
- 运行 `pnpm run typecheck`：通过；
- 运行 `pnpm run build`：通过（生成 ESM、CJS 及 .d.ts 声明文件）。
