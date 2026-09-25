# Cloudflare Workers 使用指南

本指南说明如何在 **Cloudflare Workers**（边缘 Serverless 运行时）中运行和集成 `ai-session` SDK。

---

## 目录

- [一、 兼容性原理与核心注意事项](#一-兼容性原理与核心注意事项)
- [二、 Wrangler 环境配置](#二-wrangler-环境配置)
- [三、 快速上手：内存模式（适用于单请求或测试）](#三-快速上手内存模式适用于单请求或测试)
- [四、 生产级持久化：基于 Cloudflare D1 的存储适配器](#四-生产级持久化基于-cloudflare-d1-的存储适配器)
- [五、 流式输出（SSE Streaming）最佳实践](#五-流式输出sse-streaming最佳实践)
- [六、 会话亲和性与多节点负载均衡（Session Pinning）](#六-会话亲和性与多节点负载均衡session-pinning)
- [七、 在 Cloudflare Workers 中使用知识库（RAG 与文档检索）](#七-在-cloudflare-workers-中使用知识库rag-与文档检索)
- [八、 限制与注意事项](#八-限制与注意事项)

---

## 一、 兼容性原理与核心注意事项

### 为什么底层可以兼容？
- **纯 Web 标准通信**：SDK 内部请求 OpenAI、Anthropic Claude、Google Gemini 均使用全局标准 `fetch` 与 `ReadableStream`，不依赖 Node.js 原生的 `http` / `https` 模块。
- **存储接口完全解耦**：SDK 提供了纯抽象的 `IStorage` 接口，允许开发者挂载任意外部数据库。

### 默认运行机制与环境自适应
SDK 已内置边缘运行时自适应机制：
- **常规 Node.js 环境**：若未传入 `storage`，SDK 默认启用本地 `SQLiteStorage` 并将数据保存在 `./data/ai-session.db`。
- **Cloudflare Worker 边缘环境**：若未传入 `storage`，SDK 会**自动平滑降级为 `MemoryStorage`**，不再触发 `[unenv] fs.mkdirSync` 错误，保障开箱即用不崩溃。

> 💡 **生产持久化建议**：虽然单次请求或轻量测试时可以直接省略 `storage` 参数，但在生产环境中由于 Cloudflare Worker 是多节点无状态的，若要保持跨请求、跨会话的长久记忆，依然强烈建议接入 **Cloudflare D1** 持久化存储。

---

## 二、 Wrangler 环境配置

SDK 内部用到了部分标准 Node.js 兼容层接口（如计算响应缓存 SHA-256 签名的 `node:crypto`），因此必须在 `wrangler.jsonc`（或 `wrangler.toml`）中开启 `nodejs_compat` 标志。

### `wrangler.jsonc` 配置示例
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-ai-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-02-24",
  "compatibility_flags": [
    "nodejs_compat"
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ai_session_db",
      "database_id": "xxxx-xxxx-xxxx-xxxx"
    }
  ]
}
```

---

## 三、 快速上手：内存模式（适用于单请求或测试）

如果不需要跨请求持久化会话，或者仅在单次执行生命周期内进行多轮多模型交互，可直接使用内置的 `MemoryStorage`：

```ts
import { AIClient, MemoryStorage } from "ai-session";

export interface Env {
  OPENAI_API_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 显式传入 MemoryStorage，跳过本地 SQLite 初始化
    const ai = new AIClient({
      provider: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
        model: "gpt-4o",
      },
      storage: new MemoryStorage(),
    });

    const session = ai.session({
      userId: "user_1001",
      sessionId: "sess_temp",
      system: "You are a concise AI assistant running inside Cloudflare Workers.",
    });

    const reply = await session.chat("Hello from the edge!");
    return new Response(JSON.stringify(reply), {
      headers: { "content-type": "application/json" },
    });
  },
};
```

---

## 四、 生产级持久化：基于 Cloudflare D1 的存储适配器

在 Cloudflare Worker 中，推荐使用 **Cloudflare D1**（基于 SQLite 语法的分布式边缘数据库）持久化存储多轮会话和 Token 上下文。

### 1. D1 数据表结构（Migration SQL）

在项目 `migrations/0001_create_ai_sessions.sql` 中创建表：

```sql
CREATE TABLE IF NOT EXISTS ai_sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_updated
ON ai_sessions(user_id, updated_at DESC);
```

通过 Wrangler 应用表结构：
```bash
wrangler d1 execute ai_session_db --local --file=./migrations/0001_create_ai_sessions.sql
```

### 2. D1 存储适配器实现代码 (`d1-storage.ts`)

实现 `IStorage` 接口（共 5 个异步方法）：

```ts
import type { IStorage, SessionData } from "ai-session";
import type { D1Database } from "@cloudflare/workers-types";

export class D1SessionStorage implements IStorage {
  constructor(private readonly db: D1Database) {}

  /**
   * 保存或全量覆盖会话数据
   */
  async saveSession(session: SessionData): Promise<void> {
    const serialized = JSON.stringify(session);
    await this.db
      .prepare(
        `INSERT INTO ai_sessions (user_id, session_id, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, session_id) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`
      )
      .bind(session.userId, session.sessionId, serialized, Date.now())
      .run();
  }

  /**
   * 读取指定会话数据，不存在时返回 null
   */
  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    const row = await this.db
      .prepare(`SELECT data FROM ai_sessions WHERE user_id = ? AND session_id = ?`)
      .bind(userId, sessionId)
      .first<{ data: string }>();

    if (!row || !row.data) {
      return null;
    }

    return JSON.parse(row.data) as SessionData;
  }

  /**
   * 更新已存在的会话数据
   */
  async updateSession(session: SessionData): Promise<void> {
    await this.saveSession(session);
  }

  /**
   * 删除会话
   */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM ai_sessions WHERE user_id = ? AND session_id = ?`)
      .bind(userId, sessionId)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * 列出指定用户的所有历史会话
   */
  async listSessions(userId: string): Promise<SessionData[]> {
    const { results } = await this.db
      .prepare(`SELECT data FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC`)
      .bind(userId)
      .all<{ data: string }>();

    if (!results || results.length === 0) {
      return [];
    }

    return results.map((row) => JSON.parse(row.data) as SessionData);
  }
}
```

### 3. Worker 请求处理中使用 D1Storage

```ts
import { AIClient } from "ai-session";
import { D1SessionStorage } from "./d1-storage";
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  AI_API_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") || "default_user";
    const sessionId = url.searchParams.get("sessionId") || "main_chat";

    // 初始化客户端并注入 D1Storage
    const ai = new AIClient({
      provider: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: env.AI_API_KEY,
        model: "gpt-4o",
      },
      storage: new D1SessionStorage(env.DB),
    });

    const session = ai.session({
      userId,
      sessionId,
      system: "You are a helpful persistent assistant.",
    });

    // 多轮对话自动从 D1 读取历史并写回
    const reply = await session.chat("记住我的名字叫 Alex");
    return new Response(reply.content);
  },
};
```

---

## 五、 流式输出（SSE Streaming）最佳实践

`session.chatStream` 返回一个标准的 AsyncIterable，可以直接接入 Web Stream 边生成边推送到客户端。当流传输完毕后，SDK 会**自动**把这一轮交互完整持久化到存储中。

```ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ai = new AIClient({
      provider: {
        protocol: "openai",
        apiKey: env.AI_API_KEY,
        model: "gpt-4o",
      },
      storage: new D1SessionStorage(env.DB),
    });

    const session = ai.session({
      userId: "user_1001",
      sessionId: "session_stream",
    });

    const stream = await session.chatStream("用一首诗描述 Cloudflare Worker");

    // 转换为标准 ReadableStream 发送给客户端
    const textEncoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            if (chunk.delta) {
              controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ text: chunk.delta })}\n\n`));
            }
          }
          controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  },
};
```

---

## 六、 会话亲和性与多节点负载均衡（Session Pinning）

如果你有多个 API Key 或多个中继/自建 vLLM 节点，希望在 Worker 中实现会话锁定（提高 KV / Prefix Cache 命中率并降低冷启动首字延迟）：

```ts
const ai = new AIClient({
  provider: {
    protocol: "openai",
    // 多个上游端点，自动按权重与轮询负载均衡
    endpoints: [
      { url: "https://node1.example.com/v1", apiKey: "key-1", weight: 3 },
      { url: "https://node2.example.com/v1", apiKey: "key-2", weight: 1 },
    ],
    loadBalance: {
      strategy: "weighted",
      sessionAffinity: true, // 启用 Sticky Session 锁定节点
      cooldownMs: 30000,     // 429 自动进入 30 秒熔断冷却
    },
  },
  storage: new D1SessionStorage(env.DB),
});
```

---

## 七、 在 Cloudflare Workers 中使用知识库（RAG 与文档检索）

### 1. 原生支持无盘虚拟知识库（Virtual Files & Content）
SDK 现已原生支持**无盘虚拟知识库**模式：
- **Node.js 传统后端**：继续使用 `system: { path: "./docs" }`，自动扫描物理磁盘并利用本地 SQLite FTS5 建立索引。
- **Cloudflare Worker 边缘端**：直接传入 **`files`（文件集合对象）** 或 **`content`（纯文本）**。SDK 会在内存中自动进行 Markdown 层级分块、大纲生成、Token 预算控制与关键词 RAG 匹配召回，**完全不需要读取宿主机物理磁盘**！

---

### 2. Worker 中的使用方式

#### 方式 A：文件集合对象 `files`（推荐，整个文档目录打包传入）
Worker 侧可以使用打包工具（如 Wrangler / esbuild）在构建时将 `./docs` 目录编译为一个 JSON 文件，或者在运行时从 R2 / KV 加载文件字典，然后直接塞给 SDK：

```ts
import { AIClient } from "ai-session";
import { D1SessionStorage } from "./d1-storage";
// 在 Worker 侧构建时打包或加载的文档字典：
import myDocs from "./knowledge-bundle.json"; // { "faq.md": "# 退款规则...", "api.md": "# 接口说明..." }

export default {
  async fetch(req: Request, env: any) {
    const ai = new AIClient({
      provider: { protocol: "openai", apiKey: env.AI_API_KEY, model: "gpt-4o" },
      storage: new D1SessionStorage(env.DB),
    });

    const session = ai.session({
      userId: "u1001",
      sessionId: "s_chat",
      system: {
        prompt: "你是一名官方客服助理。",
        files: myDocs,      // 👈 Worker 侧直接把文件包传给 SDK
        mode: "rag",         // 👈 享用 SDK 自动切块与关键词 RAG 检索
        maxKnowledgeTokens: 2000,
      },
    });

    // 提问时，SDK 会自动在内存中切片、提取大纲、匹配最相关的切片注入 System Prompt
    const reply = await session.chat("退款一般几天能到账？");
    return new Response(reply.content);
  }
};
```

#### 方式 B：单文本传入 `content`（适合单篇手册）
如果只有一个从 Cloudflare R2、KV 或接口拉取的大 Markdown 文档：

```ts
const session = ai.session({
  userId: "u1001",
  sessionId: "s_manual",
  system: {
    prompt: "你是一名技术顾问。",
    content: markdownString, // 👈 直接传单篇 Markdown 文本
    mode: "rag",
    maxKnowledgeTokens: 1500,
  },
});
```

---

#### 方式 B：边缘 RAG（`chunkMarkdown` + Cloudflare D1 全文检索）
如果知识库很大（数十万 Token），可利用 SDK 内置的 `chunkMarkdown` 进行切片，并利用 Cloudflare D1（基于 SQLite，支持全文检索与 SQL 查询）实现真正的边缘 RAG：

##### 1. D1 知识库切片表
```sql
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL
);
```

##### 2. 在 Worker 中切片与检索
```ts
import { AIClient, chunkMarkdown } from "ai-session";
import { D1SessionStorage } from "./d1-storage";

export default {
  async fetch(req: Request, env: any) {
    const ai = new AIClient({
      provider: { protocol: "openai", apiKey: env.AI_API_KEY, model: "gpt-4o" },
      storage: new D1SessionStorage(env.DB),
    });

    const url = new URL(req.url);

    // 接口 1: 索引文档 (将大 Markdown 切块存入 D1)
    if (url.pathname === "/index-doc" && req.method === "POST") {
      const markdown = await req.text();
      // 使用 SDK 导出的切片算法
      const chunks = chunkMarkdown("knowledge.md", markdown);

      for (const c of chunks) {
        await env.DB.prepare(
          `INSERT INTO knowledge_chunks (heading, content, tokens) VALUES (?, ?, ?)`
        ).bind(c.heading, c.content, c.tokens).run();
      }
      return new Response(JSON.stringify({ indexedChunks: chunks.length }));
    }

    // 接口 2: 对话检索 (根据用户问题模糊检索相关的 3 个 Chunk 拼入 Session)
    const userQuery = url.searchParams.get("q") || "退款流程是什么？";
    
    // 从 D1 中匹配最相关的 Chunk
    const { results } = await env.DB.prepare(
      `SELECT heading, content FROM knowledge_chunks WHERE content LIKE ? LIMIT 3`
    ).bind(`%${userQuery.slice(0, 4)}%`).all();

    const injectedContext = (results || [])
      .map((r: any) => `### ${r.heading}\n${r.content}`)
      .join("\n\n");

    const session = ai.session({
      userId: "u1",
      sessionId: "s_rag",
      system: `你是一个智能助理。参考资料如下：\n\n${injectedContext}`,
    });

    const answer = await session.chat(userQuery);
    return new Response(answer.content);
  }
};
```

---

#### 方式 C：结合 Cloudflare Vectorize + Workers AI 向量检索
Cloudflare 原生提供了 `Workers AI`（文本嵌入模型）和 `Vectorize`（向量数据库）。你可以把 SDK 的 `chunkMarkdown` 产出的文本块存入 Vectorize，查询时检索最匹配的 chunk，然后再无缝送进 `session.chat()`。

---

## 八、 限制与注意事项

1. **本地物理路径 vs 虚拟无盘模式**：
   - 在 Worker 环境中，请勿传递本地物理路径 `system: { path: "./docs" }`（Worker 无法读取宿主机物理磁盘）。
   - 请使用 SDK 原生支持的无盘模式：传入 `system: { files: myDocs }` 或 `system: { content: markdownString }`，SDK 会在内存中全自动完成智能切块、大纲生成与 RAG 检索。
2. **避免多 Worker 实例共享同一个 MemoryStorage**：
   - Cloudflare Worker 是无状态且动态伸缩的，多个请求可能被分发到不同的边缘机器。
   - 生产环境中若需要保持对话记忆连续，必须使用 **D1** 或外部持久化存储，不要只依靠 `MemoryStorage`。
3. **保持 `nodejs_compat` 启用**：
   - 依赖 `node:crypto` 等原生 API，请确保 `wrangler.jsonc` 中包含 `"compatibility_flags": ["nodejs_compat"]`。

