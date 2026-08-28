# Architecture Decisions

## ADR-001：SDK 采用 Provider 适配器和统一内部消息模型

状态：Accepted

不同 AI 服务的请求、响应和 streaming 协议不一致。Session 和 Context 不应知道底层服务商，因此 Provider 负责协议转换，核心层只依赖统一接口。

## ADR-002：Provider 配置按协议和地址建模

状态：Accepted

配置统一使用 `protocol`、`baseUrl`、`apiKey`、`model`。这样官方服务、代理、自建和本地服务都可使用同一协议适配器，不把服务商名称与 URL 绑定。

## ADR-003：完整 History 与 Context 投影分离

状态：Accepted

Context Compact 只改变当前请求使用的摘要和近期消息，不删除完整 History。这样既能恢复会话和查看历史，也能控制模型 Context Window 大小。

## ADR-004：Storage 通过接口注入，MVP 默认 Memory Storage

状态：Accepted

SDK 不绑定数据库。Memory Storage 便于零配置开发和测试，用户可以实现 PostgreSQL、Redis、MongoDB、SQLite、文件等适配器。

## ADR-005：用户体系不属于 SDK

状态：Accepted

SDK 只接收 `userId` 并用它隔离 Session；注册、登录、权限和用户资料由上层应用负责。

## ADR-006：运行时和工具版本延迟到骨架任务确认

状态：Accepted

当前仓库没有 `package.json`、锁文件、源码或测试配置。本 session 不猜测 Node.js、TypeScript、模块格式、HTTP 客户端或测试框架；TASK-002 必须先建立并记录这些基础约束。

