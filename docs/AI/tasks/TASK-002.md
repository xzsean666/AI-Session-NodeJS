# TASK-002

## Objective

建立可从 Git 安装的 Node.js/TypeScript SDK 包骨架，确认运行时、编译、模块格式、测试工具和公共入口。

## Scope

创建最小 `package.json`、TypeScript/构建配置（如需要）、源码入口、基础测试配置和包导出约定；不实现 Provider、Storage 或 Session 业务逻辑。

## Allowed Files

- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `src/index.ts`
- `test/*` 或仓库选定的测试目录
- 与所选构建/测试工具直接相关的配置文件

## Dependencies

- TASK-001 必须为 DONE。
- 开始前需要确认 Node.js、pnpm、TypeScript、模块格式和测试工具可用性。

## Inputs and Outputs

输入：当前仓库文档、可用本地 Node 工具链。

输出：可构建、可测试、可通过公共入口导入的空 SDK 包骨架。

## Acceptance Criteria

- `package.json` 定义包名、版本、入口、类型入口和必要脚本。
- 选定的 Node.js 和 pnpm 支持范围有记录。
- 公共入口可被测试导入，且不暴露内部路径。
- 不提前实现超出包骨架范围的业务功能。

## Verification Commands

以实际选定工具为准，至少运行：

```bash
pnpm install
pnpm test
pnpm build
```

## Risks and Assumptions

- 如果本地没有可用的 pnpm/TypeScript 工具链，应先记录环境阻塞，不自行替换技术栈。
- Git 安装命令需要在存在远端地址和可安装 package manifest 后验证。

## Status

DONE

