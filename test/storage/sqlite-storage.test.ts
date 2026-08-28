import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SQLiteStorage } from "../../src/storage/sqlite-storage.js";
import type { SessionData } from "../../src/types/session.js";
import { SessionNotFoundError, InvalidRequestError } from "../../src/types/errors.js";

describe("SQLiteStorage", () => {
  const testDbDir = path.resolve("./test/scratch-db");
  const testDbPath = path.join(testDbDir, "test-ai-session.db");

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it("creates tables and supports full session lifecycle in file SQLite", async () => {
    const storage = new SQLiteStorage({ dbPath: testDbPath });

    const session: SessionData = {
      userId: "user_sqlite_1",
      sessionId: "session_001",
      systemContext: "You are a database assistant",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Hello SQLite",
          createdAt: 1000,
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    };

    // Save
    await storage.saveSession(session);

    // Load
    const loaded = await storage.loadSession("user_sqlite_1", "session_001");
    expect(loaded).not.toBeNull();
    expect(loaded?.userId).toBe("user_sqlite_1");
    expect(loaded?.systemContext).toBe("You are a database assistant");
    expect(loaded?.messages).toHaveLength(1);

    // Update
    session.messages.push({
      id: "m2",
      role: "assistant",
      content: "Hello from SQLite storage",
      createdAt: 2000,
    });
    session.updatedAt = 2000;
    await storage.updateSession(session);

    const reloaded = await storage.loadSession("user_sqlite_1", "session_001");
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.updatedAt).toBe(2000);

    // List
    const list = await storage.listSessions("user_sqlite_1");
    expect(list).toHaveLength(1);

    // Delete
    const deleted = await storage.deleteSession("user_sqlite_1", "session_001");
    expect(deleted).toBe(true);
    expect(await storage.loadSession("user_sqlite_1", "session_001")).toBeNull();

    storage.close();
  });

  it("supports in-memory SQLite with :memory:", async () => {
    const storage = new SQLiteStorage({ dbPath: ":memory:" });

    const session: SessionData = {
      userId: "user_mem",
      sessionId: "session_mem",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storage.saveSession(session);
    const loaded = await storage.loadSession("user_mem", "session_mem");
    expect(loaded).not.toBeNull();

    storage.close();
  });

  it("throws SessionNotFoundError on updating non-existent session", async () => {
    const storage = new SQLiteStorage({ dbPath: ":memory:" });
    const nonExistent: SessionData = {
      userId: "unknown",
      sessionId: "unknown",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await expect(storage.updateSession(nonExistent)).rejects.toThrow(SessionNotFoundError);
    storage.close();
  });

  it("throws InvalidRequestError on invalid inputs", async () => {
    const storage = new SQLiteStorage({ dbPath: ":memory:" });
    await expect(storage.saveSession({} as any)).rejects.toThrow(InvalidRequestError);
    expect(await storage.loadSession("", "")).toBeNull();
    expect(await storage.deleteSession("", "")).toBe(false);
    expect(await storage.listSessions("")).toEqual([]);
    storage.close();
  });

  it("manages knowledge file metadata and FTS5 search", () => {
    const storage = new SQLiteStorage({ dbPath: ":memory:" });

    storage.saveFileMeta({
      filePath: "docs/order.md",
      mtime: 5000,
      size: 1024,
      hash: "abc12345",
      indexedAt: 6000,
    });

    const meta = storage.getFileMeta("docs/order.md");
    expect(meta).not.toBeNull();
    expect(meta?.hash).toBe("abc12345");

    const allMetas = storage.getAllFileMetas();
    expect(allMetas.size).toBe(1);
    expect(allMetas.get("docs/order.md")?.size).toBe(1024);

    // Save chunks
    storage.saveChunks("docs/order.md", [
      {
        heading: "docs/order.md > Order Cancellation",
        content: "Only orders in PENDING status can be cancelled.",
        tokens: 20,
      },
      {
        heading: "docs/order.md > Stock Lock",
        content: "Redis distributed lock is held for 15 minutes.",
        tokens: 25,
      },
    ]);

    expect(storage.chunkCount).toBe(2);

    // FTS5 Search
    const searchResults = storage.searchChunks("cancellation");
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0].content).toContain("PENDING status");

    const searchLock = storage.searchChunks("Redis lock");
    expect(searchLock.length).toBeGreaterThanOrEqual(1);
    expect(searchLock[0].content).toContain("15 minutes");

    // Delete file & chunks
    storage.deleteFile("docs/order.md");
    expect(storage.getFileMeta("docs/order.md")).toBeNull();
    expect(storage.chunkCount).toBe(0);

    storage.close();
  });
});
