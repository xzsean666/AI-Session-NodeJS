import { describe, it, expect, vi } from "vitest";
import {
  LoadBalancedProvider,
  normalizeEndpointTargets,
  AIClient,
  RateLimitError,
  ProviderError,
} from "../../src/index.js";

describe("LoadBalancedProvider", () => {
  it("normalizes flexible endpoint target configurations correctly", () => {
    // 1 URL + multiple Keys
    const targets1 = normalizeEndpointTargets({
      baseUrl: "https://api.openai.com/v1",
      apiKeys: ["key1", "key2", "key3"],
    });
    expect(targets1).toHaveLength(3);
    expect(targets1[0]).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key1",
      weight: 1,
      headers: undefined,
      customOptions: undefined,
    });
    expect(targets1[2].apiKey).toBe("key3");

    // Multiple URLs + 1 shared Key
    const targets2 = normalizeEndpointTargets({
      baseUrls: ["http://node1:8000/v1", "http://node2:8000/v1"],
      apiKey: "token123",
    });
    expect(targets2).toHaveLength(2);
    expect(targets2[0].baseUrl).toBe("http://node1:8000/v1");
    expect(targets2[1].baseUrl).toBe("http://node2:8000/v1");
    expect(targets2[1].apiKey).toBe("token123");

    // Explicit targets array
    const targets3 = normalizeEndpointTargets({
      targets: [
        { baseUrl: "https://endpoint-a.com", apiKey: "ka", weight: 2 },
        { baseUrl: "https://endpoint-b.com", apiKey: "kb", weight: 1 },
      ],
    });
    expect(targets3).toHaveLength(2);
    expect(targets3[0].weight).toBe(2);
    expect(targets3[1].apiKey).toBe("kb");
  });

  it("rotates requests across multiple endpoints using round-robin", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, opts: any) => {
      const authHeader = opts.headers?.Authorization;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: `Response from ${url} with auth ${authHeader}`,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new LoadBalancedProvider({
      protocol: "openai",
      model: "gpt-4o",
      baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
      apiKey: "test-key",
      fetch: fetchMock as any,
    });

    const res1 = await provider.chat({
      messages: [{ role: "user", content: "req1" }],
    });
    const res2 = await provider.chat({
      messages: [{ role: "user", content: "req2" }],
    });
    const res3 = await provider.chat({
      messages: [{ role: "user", content: "req3" }],
    });

    expect(res1.content).toContain("https://api-1.com/v1");
    expect(res2.content).toContain("https://api-2.com/v1");
    expect(res3.content).toContain("https://api-1.com/v1");
  });

  it("automatically fails over and marks cooldown on 429 RateLimitError", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string, opts: any) => {
      callCount++;
      if (url.includes("api-1.com")) {
        // Node 1 triggers 429
        return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Node 2 succeeds
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Success from node 2",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new LoadBalancedProvider({
      protocol: "openai",
      model: "gpt-4o",
      baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
      apiKey: "test-key",
      cooldownMs: 5000,
      fetch: fetchMock as any,
    });

    // Should fail over to node 2
    const res = await provider.chat({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.content).toBe("Success from node 2");
    expect(provider.isCoolingDown(0)).toBe(true);
    expect(provider.isCoolingDown(1)).toBe(false);

    // Next request should directly route to node 2 because node 1 is in cooldown
    const resNext = await provider.chat({
      messages: [{ role: "user", content: "hello again" }],
    });
    expect(resNext.content).toBe("Success from node 2");
  });

  it("integrates seamlessly into AIClient configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Auto load balance worked!" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new AIClient({
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        apiKeys: ["key-a", "key-b"],
        baseUrl: "https://api.openai.com/v1",
        fetch: fetchMock as any,
      },
    });

    const session = client.session({ userId: "u1", sessionId: "s1" });
    const reply = await session.chat("Test auto load balance");
    expect(reply.content).toBe("Auto load balance worked!");
    expect(client.getProvider()).toBeInstanceOf(LoadBalancedProvider);
  });

  it("supports priority strategy (active-passive fallback from primary to relay)", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("official.openai.com")) {
        if (callCount === 1) {
          // First call succeeds on official
          return new Response(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "From Official" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // Second call official fails (e.g. 502 Bad Gateway)
        return new Response(JSON.stringify({ error: "Service unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Backup Relay succeeds
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "From Backup Relay" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new LoadBalancedProvider({
      protocol: "openai",
      model: "gpt-4o",
      strategy: "priority",
      cooldownMs: 60000,
      targets: [
        { baseUrl: "https://official.openai.com/v1", apiKey: "key-official" },
        { baseUrl: "https://relay.example.com/v1", apiKey: "key-relay" },
      ],
      fetch: fetchMock as any,
    });

    // Request 1: Should use Target 0 (Official)
    const res1 = await provider.chat({ messages: [{ role: "user", content: "q1" }] });
    expect(res1.content).toBe("From Official");

    // Request 2: Official fails -> seamlessly falls back to Target 1 (Relay)
    const res2 = await provider.chat({ messages: [{ role: "user", content: "q2" }] });
    expect(res2.content).toBe("From Backup Relay");
    expect(provider.isCoolingDown(0)).toBe(true);

    // Request 3: While Official is cooling down, goes straight to Relay
    const res3 = await provider.chat({ messages: [{ role: "user", content: "q3" }] });
    expect(res3.content).toBe("From Backup Relay");
  });

  it("supports dynamic target updates at runtime without breaking client", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Echo ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new LoadBalancedProvider({
      protocol: "openai",
      model: "gpt-4o",
      targets: [{ baseUrl: "https://api-initial.com/v1", apiKey: "k1" }],
      fetch: fetchMock as any,
    });

    const res1 = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res1.content).toContain("https://api-initial.com/v1");

    // Dynamically hot-swap endpoints (e.g. user rotates keys or relay URLs)
    provider.updateTargets([
      { baseUrl: "https://api-new-relay.com/v1", apiKey: "new-key" },
    ]);

    const res2 = await provider.chat({ messages: [{ role: "user", content: "hi again" }] });
    expect(res2.content).toContain("https://api-new-relay.com/v1");
  });
});
