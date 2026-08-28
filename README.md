# AI Session SDK (Node.js / TypeScript)

A lightweight, resilient Node.js/TypeScript SDK for persistent AI sessions with multi-provider support and automatic context window compaction.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

---

## Features

- 🌐 **Multi-Provider Support**: Out-of-the-box adapters for OpenAI (and OpenAI-compatible services like NVIDIA NIM, OpenRouter, vLLM, LiteLLM, Ollama, DeepSeek), Anthropic Claude, and Google Gemini.
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
