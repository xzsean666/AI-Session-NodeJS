# AI Session SDK (Node.js / TypeScript)

A lightweight, resilient Node.js/TypeScript SDK for persistent AI sessions with multi-provider support and automatic context window compaction.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

---

## Features

- 🌐 **Multi-Provider Support**: Out-of-the-box adapters for OpenAI (and OpenAI-compatible services like NVIDIA NIM, OpenRouter, vLLM, LiteLLM, Ollama, DeepSeek), Anthropic Claude, and Google Gemini.
- 🎯 **Session Pinning & Load Balancing**: Support multi-API URL and multi-API Key connection pools with Round-Robin, Weighted, Random, and Priority routing, plus **Session Pinning (Sticky Session)** to lock each session to a dedicated API endpoint—maximizing KV / Prefix Cache hit rates on LLMs (Claude, DeepSeek, vLLM, OpenAI), cutting TTFT latency by 80%+ and saving up to 90% prompt tokens with automatic failover re-pinning.
- 💾 **Default SQLite Persistence**: Uses Node.js native `node:sqlite` (Node >= 22.5) with zero external runtime dependencies. Automatically stores sessions and history at `./data/ai-session.db`.
- 📚 **Markdown & Code Knowledge Base**: Pass a `.md` file or directory path directly into `system`. Built-in Markdown heading chunking, TOC outline generation, and incremental SQLite change detection.
- 🔍 **FTS5 RAG & Token Optimization**: Built-in full-text search with dynamic relevant chunk injection (`mode: "rag"`), saving up to 95% of prompt tokens.
- 🧹 **Automatic Context Compaction**: Automatically monitors Token budgets and generates concise summaries of older conversation turns while keeping the complete history intact.
- ⚡ **Full Streaming & Non-Streaming**: First-class async iterator support for SSE streams with automatic turn persistence upon completion.
- 🔌 **Pluggable Storage Abstraction**: Ships with built-in `SQLiteStorage` (default) and `MemoryStorage`, plus an `IStorage` interface for custom databases (Redis, PostgreSQL, MongoDB).
- 🛡️ **Zero External Runtime Dependencies**: Built directly on native Node.js standard modules (`node:sqlite`, `fetch`, and Web Streams).

---

## Installation

Install directly via Git with `pnpm`, `npm`, or `yarn`:

```bash
pnpm add git+https://github.com/xzsean666/AI-Session-NodeJS.git
```

Requirements:
- Node.js >= 20.0.0 (Node >= 22.5.0 recommended for native `node:sqlite`)
- pnpm >= 8.0.0 / npm >= 9.0.0

---

## Quickstart

```ts
import { AIClient } from "ai-session";

// 1. Initialize client (defaults to SQLite storage at ./data/ai-session.db)
const ai = new AIClient({
  provider: {
    protocol: "openai",
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || "gpt-4o",
  },
});

// 2. Open a persistent session
const session = ai.session({
  userId: "user_1001",
  sessionId: "session_abc",
  system: "You are a helpful coding assistant.",
});

// 3. Chat with automatic history persistence in SQLite
const reply = await session.chat("Hello! What is Node.js?");
console.log(reply.content);

// 4. Continue the conversation in the same session
const nextReply = await session.chat("Show me how to read a file.");
console.log(nextReply.content);

// 5. Inspect full history
const history = await session.getHistory();
console.log("Total messages:", history.length);
```

---

## Knowledge Base (Directory & Markdown Files)

Pass a markdown file or directory directly as your system context. The SDK automatically parses headings, builds a TOC outline, and performs fast incremental SQLite FTS5 chunk retrieval:

```ts
const session = ai.session({
  userId: "dev_user",
  sessionId: "project_qna",
  system: {
    prompt: "You are an expert architect for this project.",
    path: "./docs",           // Directory containing .md and code files
    mode: "rag",              // 'rag' (FTS5 search, saves 95% tokens) | 'skeleton' | 'full'
    maxKnowledgeTokens: 2000, // Token budget for injected knowledge
  },
});

// Directly asks questions based on local files
const answer = await session.chat("What is the refund policy for VIP orders?");
console.log(answer.content);
```

---

## Streaming

Receive chunks in real-time. The SDK automatically collects and persists the complete assistant response upon stream completion:

```ts
const session = ai.session({
  userId: "user_1001",
  sessionId: "stream_session_1",
});

const stream = await session.chatStream("Write a haiku about TypeScript.");

for await (const chunk of stream) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }
}

// Conversation turn is now fully persisted in storage!
```

---

## Provider Support

### 1. OpenAI & OpenAI-Compatible Services (vLLM, Ollama, DeepSeek, LiteLLM)

```ts
const ai = new AIClient({
  provider: {
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1", // Local Ollama or custom gateway
    apiKey: "optional-api-key",
    model: "llama3",
  },
});
```

### 2. Anthropic Claude

```ts
const ai = new AIClient({
  provider: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-3-5-sonnet-20241022",
  },
});
```

### 3. Google Gemini

```ts
const ai = new AIClient({
  provider: {
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-1.5-pro",
  },
});
```

---

## Load Balancing & Session Pinning (负载均衡与会话锁定)

当部署了多个模型镜像节点（如多个 vLLM/SGLang 实例、多个中转 API 或多组 API Key）时，直接轮询往往会打乱服务端前序 KV Cache 的命中。

现代大模型（Claude Prompt Caching, DeepSeek Prefix Caching, OpenAI Prompt Caching, vLLM PagedAttention）严重依赖**会话亲和性**。开启 `sessionAffinity: true`（或设置 `loadBalance.sessionAffinity: true`），SDK 会自动将每个 `sessionId` 锁定（Pin）到分配的特定健康节点上：
- ⚡ **超低首字延迟 (TTFT)**：服务端 100% 命中前序对话上下文的 KV Cache，首字延迟缩短 80%+。
- 💰 **大幅节省 Token 费用**：命中 Prefix Cache 的 Prompt Tokens 通常享有 50%~90% 的计费折扣。
- 🛡️ **透明故障转移与自动重新绑定 (Automatic Failover & Re-pinning)**：若当前 Pin 的节点遭遇 429 限流或 5xx 故障，SDK 毫秒级自动切换到其他可用节点，并在调用成功后将该会话平滑重新绑定到新健康节点！

```ts
import { AIClient } from "ai-session";

const ai = new AIClient({
  // 全局开启会话亲和锁定
  sessionAffinity: true,
  provider: {
    protocol: "openai",
    model: "deepseek-chat",
    // 配置多个 API 镜像节点或中转线路
    baseUrls: [
      "https://node-1.gpu-cluster.internal/v1",
      "https://node-2.gpu-cluster.internal/v1",
      "https://node-3.gpu-cluster.internal/v1",
    ],
    apiKey: process.env.API_KEY,
    loadBalance: {
      strategy: "round-robin", // 初始分配策略：round-robin | weighted | random | priority
      cooldownMs: 30000,        // 429 报错时冷却该节点 30 秒
      repinOnFailover: true,   // 故障切换成功后自动更新会话锁定至新节点 (默认 true)
    },
  },
});

// 会话 1：自动分配并锁定到 node-1
const session1 = ai.session({ userId: "u1", sessionId: "sess-1" });
const res1 = await session1.chat("你好！");
console.log("响应节点:", res1.target?.baseUrl); // -> https://node-1.gpu-cluster.internal/v1

// 会话 1 后续提问始终走 node-1 (极大提高 Prefix Cache 命中率)
const res2 = await session1.chat("请接着上文继续分析...");
console.log("响应节点:", res2.target?.baseUrl); // -> 依然是 node-1

// 支持显式锁定或查看会话绑定的节点：
console.log("当前锁定信息:", session1.getPinnedTargetInfo());
// session1.pinTarget("https://node-2.gpu-cluster.internal/v1"); // 手动改绑
// session1.unpinTarget(); // 解除锁定
```

---

## Automatic Context Compaction

As conversations grow, sending all past messages to the model can exceed the model's Context Window and increase latency.

`AIClient` includes built-in Token budget management via `ContextManager`:

```ts
const ai = new AIClient({
  provider: { ... },
  contextOptions: {
    maxContextTokens: 4096,
    compactThresholdRatio: 0.75, // Triggers compaction when context reaches 75%
    keepRecentMessages: 4,       // Keep last 4 turns uncompacted
    autoCompact: true,
  },
});
```

### How Compaction Works
1. When total estimated tokens reach the threshold, older conversation turns are summarized via the AI Provider.
2. The resulting summary is stored in `session.summary`.
3. The prompt sent to the model is projected as:
   `[System Prompt] + [Previous Summary] + [Recent Uncompacted Messages]`.
4. **Full History is Never Lost**: `session.getHistory()` always contains 100% of past messages for analytics and user display.

---

## Custom Storage Provider

Implement the simple `IStorage` interface to use PostgreSQL, Redis, SQLite, MongoDB, or any persistence layer:

```ts
import { AIClient, type IStorage, type SessionData } from "ai-session";

export class RedisStorage implements IStorage {
  constructor(private redisClient: any) {}

  async saveSession(session: SessionData): Promise<void> {
    await this.redisClient.set(`session:${session.userId}:${session.sessionId}`, JSON.stringify(session));
  }

  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    const raw = await this.redisClient.get(`session:${userId}:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async updateSession(session: SessionData): Promise<void> {
    await this.saveSession(session);
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    return (await this.redisClient.del(`session:${userId}:${sessionId}`)) > 0;
  }

  async listSessions(userId: string): Promise<SessionData[]> {
    // query by pattern
    return [];
  }
}

// Inject into client:
const ai = new AIClient({
  provider: { ... },
  storage: new RedisStorage(redisClient),
});
```

---

## Error Handling

The SDK provides typed errors for granular handling:

```ts
import {
  AISessionError,
  AuthenticationError,
  RateLimitError,
  ProviderError,
  SessionNotFoundError,
  CompactError,
} from "ai-session";

try {
  await session.chat("Hello");
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error("Invalid API Key or authorization failure");
  } else if (error instanceof RateLimitError) {
    console.error("Provider rate limit reached");
  } else if (error instanceof ProviderError) {
    console.error(`Provider error [${error.statusCode}]: ${error.message}`);
  }
}
```

---

## Development & Verification

```bash
# Install dependencies
pnpm install

# Run all test suites
pnpm test

# Type check
pnpm run typecheck

# Build bundle (ESM + CJS + TypeScript .d.ts)
pnpm run build
```

---

## License

MIT
