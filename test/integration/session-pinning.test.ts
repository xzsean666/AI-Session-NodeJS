import { describe, it, expect, vi } from "vitest";
import { AIClient, MemoryStorage, SQLiteStorage } from "../../src/index.js";

describe("Session Pinning Integration (AIClient & Session)", () => {
  it("maintains endpoint affinity across multiple turns for a session in AIClient", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Echo from ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new AIClient({
      storage: new MemoryStorage(),
      sessionAffinity: true,
      provider: {
        protocol: "openai",
        model: "deepseek-chat",
        baseUrls: ["https://api-1.ai.com/v1", "https://api-2.ai.com/v1"],
        apiKey: "shared-key",
        fetch: fetchMock as any,
      },
    });

    const sessionA = client.session({ userId: "u1", sessionId: "sess-a" });
    const sessionB = client.session({ userId: "u1", sessionId: "sess-b" });

    // Turn 1
    const resA1 = await sessionA.chat("Message A1");
    const resB1 = await sessionB.chat("Message B1");

    expect(resA1.content).toContain("https://api-1.ai.com/v1");
    expect(resA1.target?.baseUrl).toBe("https://api-1.ai.com/v1");
    expect(resB1.content).toContain("https://api-2.ai.com/v1");
    expect(resB1.target?.baseUrl).toBe("https://api-2.ai.com/v1");

    // Turn 2: verify sticky routing (pinning)
    const resA2 = await sessionA.chat("Message A2");
    const resB2 = await sessionB.chat("Message B2");

    expect(resA2.content).toContain("https://api-1.ai.com/v1");
    expect(resB2.content).toContain("https://api-2.ai.com/v1");

    // Turn 3: check getPinnedTargetInfo
    const pinA = sessionA.getPinnedTargetInfo();
    const pinB = sessionB.getPinnedTargetInfo();

    expect(pinA?.baseUrl).toBe("https://api-1.ai.com/v1");
    expect(pinB?.baseUrl).toBe("https://api-2.ai.com/v1");
  });

  it("persists pinnedTarget across session reloads from storage", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Handled by ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const storage = new SQLiteStorage({ dbPath: ":memory:" });

    const client1 = new AIClient({
      storage,
      sessionAffinity: true,
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://server-a.com/v1", "https://server-b.com/v1"],
        apiKey: "k1",
        fetch: fetchMock as any,
      },
    });

    // Session initial interaction
    const session1 = client1.session({ userId: "user-100", sessionId: "sess-reload" });
    const res1 = await session1.chat("Initial chat");
    expect(res1.target?.baseUrl).toBe("https://server-a.com/v1");

    // Check stored session data
    const rawSaved = await storage.loadSession("user-100", "sess-reload");
    expect(rawSaved?.pinnedTarget?.baseUrl).toBe("https://server-a.com/v1");

    // Simulate new client / app reboot
    const client2 = new AIClient({
      storage,
      sessionAffinity: true,
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://server-a.com/v1", "https://server-b.com/v1"],
        apiKey: "k1",
        fetch: fetchMock as any,
      },
    });

    // Load existing session
    const reloadedSession = await client2.loadSession("user-100", "sess-reload");
    expect(reloadedSession).not.toBeNull();

    // Subsequent turn after restart must stick to server-a
    const res2 = await reloadedSession!.chat("Turn after reload");
    expect(res2.target?.baseUrl).toBe("https://server-a.com/v1");
  });

  it("allows explicit manual pinTarget and unpinTarget on Session", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Route: ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new AIClient({
      storage: new MemoryStorage(),
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://endpoint-0.com/v1", "https://endpoint-1.com/v1"],
        apiKey: "test",
        fetch: fetchMock as any,
      },
    });

    const session = client.session({ userId: "user-dev", sessionId: "sess-manual" });

    // Manually pin session to endpoint-1
    session.pinTarget("https://endpoint-1.com/v1");
    expect(session.getPinnedTarget()?.baseUrl).toBe("https://endpoint-1.com/v1");

    const reply1 = await session.chat("Hello manual pin");
    expect(reply1.content).toContain("https://endpoint-1.com/v1");

    // Unpin session
    session.unpinTarget();
    expect(session.getPinnedTarget()).toBeUndefined();
  });

  it("works seamlessly with response-level caching and session pinning", async () => {
    let networkCallCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      networkCallCount++;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Live from ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new AIClient({
      storage: new MemoryStorage(),
      cache: true, // ResponseCache enabled
      sessionAffinity: true,
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://node-one.com/v1", "https://node-two.com/v1"],
        apiKey: "key",
        fetch: fetchMock as any,
      },
    });

    const session1 = client.session({ userId: "u1", sessionId: "sess-cache-pin-1" });
    const session2 = client.session({ userId: "u2", sessionId: "sess-cache-pin-2" });

    // Session 1 Question 1: hits network, pins session1 to node-one
    const res1 = await session1.chat("Identical Question");
    expect(networkCallCount).toBe(1);
    expect(res1.content).toContain("https://node-one.com/v1");
    expect(res1.cached).toBe(false);

    // Session 2 Question 1: identical prompt -> hits response cache directly without network request!
    const res2 = await session2.chat("Identical Question");
    expect(networkCallCount).toBe(1);
    expect(res2.cached).toBe(true);
    expect(res2.content).toBe(res1.content);

    // Session 1 Question 2: different prompt -> hits network, continues to stick to node-one
    const res3 = await session1.chat("Another unique question");
    expect(networkCallCount).toBe(2);
    expect(res3.content).toContain("https://node-one.com/v1");
    expect(res3.target?.baseUrl).toBe("https://node-one.com/v1");
  });

  it("respects pinSession: false override per session even if client has sessionAffinity: true", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `Echo ${url}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new AIClient({
      storage: new MemoryStorage(),
      sessionAffinity: true, // globally enabled
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
        apiKey: "key",
        fetch: fetchMock as any,
      },
    });

    // Session opting out of affinity
    const sessionNoPin = client.session({
      userId: "u",
      sessionId: "sess-no-pin",
      pinSession: false,
    });

    // Round 1
    const res1 = await sessionNoPin.chat("Q1");
    expect(res1.content).toContain("https://api-1.com/v1");

    // Round 2: should rotate to api-2 because session pinning was opted out
    const res2 = await sessionNoPin.chat("Q2");
    expect(res2.content).toContain("https://api-2.com/v1");
  });

  it("unpins session when session.delete() is called", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new AIClient({
      storage: new MemoryStorage(),
      sessionAffinity: true,
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
        apiKey: "key",
        fetch: fetchMock as any,
      },
    });

    const session = client.session({ userId: "u", sessionId: "sess-to-delete" });
    await session.chat("Hello");
    expect(session.getPinnedTarget()).toBeDefined();

    // Delete session via session.delete()
    await session.delete();
    expect(session.getPinnedTarget()).toBeUndefined();

    // Delete session via client.deleteSession()
    const session2 = client.session({ userId: "u", sessionId: "sess-to-delete-via-client" });
    await session2.chat("Hello 2");
    const lbProvider = client.getProvider() as LoadBalancedProvider;
    expect(lbProvider.getPinnedTarget("sess-to-delete-via-client")).toBeDefined();
    await client.deleteSession("u", "sess-to-delete-via-client");
    expect(lbProvider.getPinnedTarget("sess-to-delete-via-client")).toBeUndefined();
  });

  it("evicts oldest pinned sessions when maxPinnedSessions capacity is reached", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new AIClient({
      storage: new MemoryStorage(),
      provider: {
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
        apiKey: "key",
        loadBalance: {
          sessionAffinity: true,
          maxPinnedSessions: 2, // Only retain 2 sessions
        },
        fetch: fetchMock as any,
      },
    });

    const s1 = client.session({ userId: "u", sessionId: "sess-lru-1" });
    const s2 = client.session({ userId: "u", sessionId: "sess-lru-2" });
    const s3 = client.session({ userId: "u", sessionId: "sess-lru-3" });

    await s1.chat("q1");
    await s2.chat("q2");
    expect(s1.getPinnedTarget()).toBeDefined();
    expect(s2.getPinnedTarget()).toBeDefined();

    // Triggering s3 should evict s1 (the oldest)
    await s3.chat("q3");
    expect(s1.getPinnedTarget()).toBeUndefined();
    expect(s2.getPinnedTarget()).toBeDefined();
    expect(s3.getPinnedTarget()).toBeDefined();
  });
});
