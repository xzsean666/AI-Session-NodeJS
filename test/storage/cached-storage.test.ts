import { describe, it, expect, vi } from "vitest";
import {
  CachedStorage,
  MemoryStorage,
  SQLiteStorage,
  AIClient,
  type SessionData,
} from "../../src/index.js";

describe("CachedStorage", () => {
  it("accelerates session loads from L1 memory cache without calling underlying storage", async () => {
    const memory = new MemoryStorage();
    const loadSpy = vi.spyOn(memory, "loadSession");

    const cachedStorage = new CachedStorage(memory, { ttlMs: 10000, maxSessions: 10 });

    const session: SessionData = {
      userId: "user-1",
      sessionId: "session-1",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Save session into cached storage
    await cachedStorage.saveSession(session);
    expect(cachedStorage.cachedCount).toBe(1);

    // First load -> served directly from L1 memory cache (0 calls to memory.loadSession!)
    const loaded1 = await cachedStorage.loadSession("user-1", "session-1");
    expect(loaded1?.sessionId).toBe("session-1");
    expect(loadSpy).toHaveBeenCalledTimes(0);

    // Clear cache to simulate cold read -> now hits underlying storage and repopulates L1 cache
    cachedStorage.clearCache();
    expect(cachedStorage.cachedCount).toBe(0);

    const loaded2 = await cachedStorage.loadSession("user-1", "session-1");
    expect(loaded2?.sessionId).toBe("session-1");
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(cachedStorage.cachedCount).toBe(1);

    // Second read -> hits L1 cache again
    await cachedStorage.loadSession("user-1", "session-1");
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("handles updates, deletes, and transparently proxies SQLiteStorage custom methods", async () => {
    const sqlite = new SQLiteStorage({ dbPath: ":memory:" });
    const cachedStorage = new CachedStorage(sqlite);

    const session: SessionData = {
      userId: "user-2",
      sessionId: "session-2",
      messages: [{ role: "user", content: "first", timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await cachedStorage.saveSession(session);

    // Update
    session.messages.push({ role: "assistant", content: "second", timestamp: Date.now() });
    await cachedStorage.updateSession(session);

    const reloaded = await cachedStorage.loadSession("user-2", "session-2");
    expect(reloaded?.messages).toHaveLength(2);

    // Delete
    const deleted = await cachedStorage.deleteSession("user-2", "session-2");
    expect(deleted).toBe(true);
    expect(await cachedStorage.loadSession("user-2", "session-2")).toBeNull();

    // Verify proxy method works (e.g. SQLite specific methods)
    expect(typeof (cachedStorage as any).getAllFileMetas).toBe("function");
  });

  it("AIClient supports storageCache option seamlessly", async () => {
    const mockProvider = {
      protocol: "openai",
      chat: async () => ({ role: "assistant" as const, content: "ok" }),
      chatStream: async function* () {
        yield { delta: "ok", done: true };
      },
    };

    const client = new AIClient({
      provider: mockProvider,
      storage: new MemoryStorage(),
      storageCache: true,
    });

    expect(client.getStorage()).toBeInstanceOf(CachedStorage);

    const session = client.session({ userId: "u", sessionId: "s" });
    await session.chat("hello");

    const loaded = await client.loadSession("u", "s");
    expect(loaded).not.toBeNull();
    const history = await loaded!.getHistory();
    expect(history).toHaveLength(2);
  });
});
