# TASK-011

## Objective

完成 Git 安装体验、README 使用示例和发布前的包完整性检查。

## Scope

记录实际包名、远端地址、Node/pnpm 支持范围、安装命令、公共 API 示例、环境变量和验证步骤；不新增 MVP 业务能力。

## Allowed Files

- `README.md`
- `package.json`
- `pnpm-lock.yaml`
- `docs/*`
- `examples/*`
- 发布或 CI 配置（仅在仓库已有约定时）

## Dependencies

TASK-010。

## Inputs and Outputs

输入：可运行的 SDK 和真实 Git/package 元数据。输出：用户可复制验证的安装和使用文档。

## Acceptance Criteria

- `pnpm add git+<repository-url>` 在干净示例项目中可安装。
- README 示例覆盖配置、创建/恢复 Session、Chat、streaming 和 Storage 注入。
- 文档不承诺未实现的 Tool Calling、RAG 或其他非 MVP 能力。
- 包构建产物和 exports 与 README 使用方式一致。

## Verification Commands

```bash
pnpm pack --dry-run
pnpm install
pnpm test
pnpm build
```

## Risks and Assumptions

实际远端 URL、包名和发布策略在仓库初始化后才能写入；不要使用占位地址宣称已验证。

## Status

DONE

