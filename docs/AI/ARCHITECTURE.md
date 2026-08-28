# AI Session SDK 架构

## 1. 分层

```text
Application
    |
    v
AIClient
    |
    +-- SessionManager ---- Storage
    |         |
    |         +------------ ContextManager ---- CompactStrategy
    |                                      |
    |                                      v
    +------------------------------- ProviderManager
                                      |
                         +------------+------------+
                         v            v            v
                      OpenAI      Anthropic      Gemini
```

`AIClient` 是应用入口；Session 负责对话生命周期；Context Manager 负责当前请求的上下文投影；Provider 负责外部协议；Storage 负责持久化。依赖方向应保持从接口层/业务层指向适配器，不让 Provider 直接访问 Storage。

## 2. 核心数据模型

### ProviderConfig

```text
protocol  API 协议类型，例如 openai、anthropic、gemini
baseUrl   API 地址，可指向官方、代理或自建服务
apiKey    认证信息
model     模型标识
```

### Session

```text
userId          上层业务提供的用户标识
sessionId       会话标识
systemContext   系统提示或系统上下文
messages        完整历史消息
summary         最近一次 Compact 的摘要，可为空
metadata        扩展元数据
```

消息采用 SDK 内部统一结构，至少区分 `system`、`user`、`assistant` 角色，并为后续 streaming 保留增量内容的表达空间。具体字段在 TASK-003 固化。

## 3. Session 请求流程

```text
session.chat(input)
    |
    +-- load Session by userId + sessionId
    +-- append user message to complete History
    +-- ContextManager builds system + summary + recent messages
    +-- check context threshold
    |       |
    |       +-- below threshold: continue
    |       +-- above threshold: compact through unified Provider interface
    +-- Provider sends unified request
    +-- append assistant response to complete History
    +-- Storage persists updated Session
    +-- return response or stream
```

失败请求不能伪造 assistant 消息。持久化时应保证同一 Session 的更新不会意外覆盖另一用户的数据；并发语义在实现 Storage 时明确记录。

## 4. Provider 架构

Provider 实现统一接口，将内部消息转换成各协议的请求，再将响应转换回统一响应。Provider 不感知 Session、用户或 Storage。

- OpenAI Compatible Provider：支持 OpenAI 官方、代理、LiteLLM、vLLM、自建及本地兼容服务。
- Anthropic Provider：处理 Claude 协议的 system、messages 和 streaming 差异。
- Gemini Provider：处理 Gemini 内容结构和生成响应差异。

Provider 配置使用 `protocol` 和 `baseUrl` 解耦服务商与协议；不要按服务商名称硬编码 URL。

## 5. Context 与 Compact

History 是完整事实记录，Context 是发送给模型的临时视图。Context Manager 组合 `systemContext + summary + recent messages`，估算 token 使用量，并在接近模型限制时触发 Compact。

Compact 通过统一 AI 接口生成摘要，不绑定某个 Provider。Compact 成功后更新 `summary` 和 Context 投影，但不删除完整 History。Compact 失败时应保留原有 Session 数据并返回可识别的错误。

Token 估算先使用可测试的明确策略；精确 tokenizer 是否引入额外依赖由后续实现 Task 根据实际协议决定。

## 6. Storage 接口边界

Storage 至少支持：保存、加载、更新、删除 Session，以及按 `userId` 查询 Session。Memory Storage 作为默认实现用于开发和测试；生产数据库由用户通过接口注入。

Storage 不负责 AI 请求、Context 计算、Compact 或 Provider 选择。

## 7. 包与公共 API

公共入口只暴露稳定的 `AIClient`、配置类型、Session 结果类型和可注入接口。内部适配器可以继续演进，不应要求应用直接依赖内部文件路径。

目标安装方式是：

```bash
pnpm add git+<repository-url>
```

实际包名、入口文件、模块格式、Node.js 支持范围和构建命令在 TASK-002/TASK-011 通过仓库配置确认后写入 README。

