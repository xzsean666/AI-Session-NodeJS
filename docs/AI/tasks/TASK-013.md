# TASK-013：实现 Markdown/代码知识库、增量缓存与动态 RAG 检索

## 状态

DONE

## 目标

为 `Session` 提供直接传入 Markdown 文档或知识库目录的能力，实现标题语义切片、轻量大纲（TOC）构建、TypeScript 骨架提取、基于文件 mtime 的毫秒级增量缓存，以及无硬编码截断的 FTS5 动态 RAG 上下文注入。

## 详细要求

1. **Markdown 语义分块与清洗**：
   - 依据 `# H1`、`## H2`、`### H3` 等标题分块，保留面包屑路径；
   - 自动清除 HTML 注释、图片外链与冗余换行。
2. **TypeScript 代码骨架提取**：
   - 提取 `interface`、`type` 与导出函数/类签名，移除函数体实现，节省 80% Token。
3. **毫秒级增量比对**：
   - 比对文件 `mtimeMs` 与 `size`，未修改文件 0ms 跳过，变动文件增量重建索引。
4. **动态 RAG 检索与上下文组装**：
   - 对话时根据用户提问在 SQLite FTS5 索引中检索匹配片段；
   - 默认不设置狭窄的 Token 硬上限（`maxKnowledgeTokens` 可选），确保信息完整性；
   - 组装包含全局大纲（TOC）与命中小节的结构化 System 上下文。
5. **Provider 弹性重试**：
   - 内置 `fetchWithRetry`，对 429 和 503 错误自动执行指数退避重试。

## 涉及文件

- `src/knowledge/markdown-chunker.ts`
- `src/knowledge/code-skeleton.ts`
- `src/knowledge/knowledge-manager.ts`
- `src/session/session.ts`
- `src/provider/utils.ts`
- `test/knowledge/knowledge-manager.test.ts`
- `test/integration/knowledge-session.test.ts`
