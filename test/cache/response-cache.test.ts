import { describe, it, expect, vi } from "vitest";
import {
  ResponseCache,
  CachedProvider,
  AIClient,
  type IProvider,
  type ProviderChatRequest,
} from "../../src/index.js";

describe("ResponseCache & CachedProvider", () => {
  it("caches and retrieves responses with TTL and LRU eviction", async () => {
    const cache = new ResponseCache({ ttlMs: 100, maxEntries: 2 });
    const req1: ProviderChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    };
    const req2: ProviderChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "world" }],
    };
    const req3: ProviderChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "foo" }],
    };

    const key1 = cache.generateKey(req1, "openai");
    const key2 = cache.generateKey(req2, "openai");
    const key3 = cache.generateKey(req3, "openai");

    cache.set(key1, { role: "assistant", content: "hello reply" });
    cache.set(key2, { role: "assistant", content: "world reply" });

    expect(cache.has(key1)).toBe(true);
    expect(cache.has(key2)).toBe(true);
    expect(cache.get(key1)?.content).toBe("hello reply");

    // Adding key3 should evict LRU (which is key2, since key1 was accessed)
    cache.set(key3, { role: "assistant", content: "foo reply" });
    expect(cache.has(key3)).toBe(true);
    expect(cache.has(key1)).toBe(true);
    expect(cache.has(key2)).toBe(false);

    // Test TTL expiration
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.get(key1)).toBeUndefined();
    expect(cache.has(key1)).toBe(false);
  });

  it("CachedProvider prevents redundant LLM calls on identical requests", async () => {
    let callCount = 0;
    const mockProvider: IProvider = {
      protocol: "openai",
      chat: async (req) => {
        callCount++;
        return {
          role: "assistant",
          content: `Computed answer ${callCount}: ${req.messages[0].content}`,
        };
      },
      chatStream: async function* (req) {
        callCount++;
        yield { delta: `Streamed answer ${callCount}`, done: true };
      },
    };

    const cachedProvider = new CachedProvider(mockProvider, { ttlMs: 10000 });

    const req: ProviderChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    };

    // First call -> hits provider
    const res1 = await cachedProvider.chat(req);
    expect(res1.content).toBe("Computed answer 1: What is the capital of France?");
    expect(callCount).toBe(1);

    // Second call -> hits cache (0 network call!)
    const res2 = await cachedProvider.chat(req);
    expect(res2.content).toBe("Computed answer 1: What is the capital of France?");
    expect(callCount).toBe(1);

    // Bypass cache with noCache: true
    const res3 = await cachedProvider.chat({
      ...req,
      customOptions: { noCache: true },
    });
    expect(res3.content).toBe("Computed answer 2: What is the capital of France?");
    expect(callCount).toBe(2);
  });

  it("CachedProvider supports streaming and caches stream result for subsequent stream calls", async () => {
    let callCount = 0;
    const mockProvider: IProvider = {
      protocol: "openai",
      chat: async () => ({ role: "assistant", content: "test" }),
      chatStream: async function* () {
        callCount++;
        yield { delta: "Hello ", done: false };
        yield { delta: "world!", done: true };
      },
    };

    const cachedProvider = new CachedProvider(mockProvider, { ttlMs: 10000 });
    const req: ProviderChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Stream test" }],
    };

    // Stream 1: misses cache, executes provider stream
    let output1 = "";
    for await (const chunk of await cachedProvider.chatStream(req)) {
      output1 += chunk.delta;
    }
    expect(output1).toBe("Hello world!");
    expect(callCount).toBe(1);

    // Stream 2: hits cache, replays cached stream (0 provider call!)
    let output2 = "";
    for await (const chunk of await cachedProvider.chatStream(req)) {
      output2 += chunk.delta;
    }
    expect(output2).toBe("Hello world!");
    expect(callCount).toBe(1);
  });

  it("AIClient enables cache via options.cache = true", async () => {
    let callCount = 0;
    const mockProvider: IProvider = {
      protocol: "openai",
      chat: async () => {
        callCount++;
        return { role: "assistant", content: `Call #${callCount}` };
      },
      chatStream: async function* () {
        yield { delta: "stream", done: true };
      },
    };

    const client = new AIClient({
      provider: mockProvider,
      cache: true,
    });

    const session = client.session({ userId: "u1", sessionId: "s1" });
    const r1 = await session.chat("Repeat question");
    expect(r1.content).toBe("Call #1");
    expect(callCount).toBe(1);
  });
});
