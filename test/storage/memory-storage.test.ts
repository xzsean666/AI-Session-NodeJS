import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorage } from "../../src/storage/memory-storage.js";
import { SessionNotFoundError, InvalidRequestError } from "../../src/types/errors.js";
import type { SessionData } from "../../src/types/session.js";

describe("MemoryStorage (TASK-004)", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  const createSampleSession = (userId: string, sessionId: string, text = "hello"): SessionData => ({
    userId,
    sessionId,
    systemContext: "system context",
    messages: [
      {
        id: "m1",
        role: "user",
        content: text,
        createdAt: 1000,
      },
    ],
    summary: undefined,
    metadata: { env: "test" },
    createdAt: 1000,
    updatedAt: 1000,
  });

  describe("CRUD operations", () => {
    it("saves and loads a session successfully", async () => {
      const session = createSampleSession("u1", "s1");
      await storage.saveSession(session);

      const loaded = await storage.loadSession("u1", "s1");
      expect(loaded).toBeDefined();
      expect(loaded?.userId).toBe("u1");
      expect(loaded?.sessionId).toBe("s1");
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe("hello");
    });

    it("returns null when loading non-existent session", async () => {
      const loaded = await storage.loadSession("u1", "non_existent");
      expect(loaded).toBeNull();
    });

    it("updates an existing session", async () => {
      const session = createSampleSession("u1", "s1");
      await storage.saveSession(session);

      session.messages.push({
        id: "m2",
        role: "assistant",
        content: "world",
        createdAt: 2000,
      });
      session.updatedAt = 2000;
      await storage.updateSession(session);

      const updated = await storage.loadSession("u1", "s1");
      expect(updated?.messages).toHaveLength(2);
      expect(updated?.updatedAt).toBe(2000);
    });

    it("throws SessionNotFoundError when updating a session that does not exist", async () => {
      const session = createSampleSession("u1", "s999");
      await expect(storage.updateSession(session)).rejects.toThrow(SessionNotFoundError);
    });

    it("deletes a session and returns true, returns false if not found", async () => {
      const session = createSampleSession("u1", "s1");
      await storage.saveSession(session);

      expect(await storage.deleteSession("u1", "s1")).toBe(true);
      expect(await storage.loadSession("u1", "s1")).toBeNull();
      expect(await storage.deleteSession("u1", "s1")).toBe(false);
    });
  });

  describe("User and Session Isolation", () => {
    it("does not overwrite session with same sessionId under different userIds", async () => {
      const sessionUserA = createSampleSession("user_A", "session_shared", "Message from A");
      const sessionUserB = createSampleSession("user_B", "session_shared", "Message from B");

      await storage.saveSession(sessionUserA);
      await storage.saveSession(sessionUserB);

      const loadedA = await storage.loadSession("user_A", "session_shared");
      const loadedB = await storage.loadSession("user_B", "session_shared");

      expect(loadedA?.messages[0].content).toBe("Message from A");
      expect(loadedB?.messages[0].content).toBe("Message from B");
      expect(storage.size).toBe(2);
    });

    it("lists sessions only for the requested user", async () => {
      await storage.saveSession({ ...createSampleSession("user_A", "s1"), updatedAt: 100 });
      await storage.saveSession({ ...createSampleSession("user_A", "s2"), updatedAt: 200 });
      await storage.saveSession({ ...createSampleSession("user_B", "s3"), updatedAt: 300 });

      const listA = await storage.listSessions("user_A");
      expect(listA).toHaveLength(2);
      expect(listA[0].sessionId).toBe("s2"); // sorted by updatedAt desc
      expect(listA[1].sessionId).toBe("s1");

      const listB = await storage.listSessions("user_B");
      expect(listB).toHaveLength(1);
      expect(listB[0].sessionId).toBe("s3");

      const listC = await storage.listSessions("user_C");
      expect(listC).toEqual([]);
    });
  });

  describe("Data immutability and references", () => {
    it("does not allow external mutations to affect stored data after save", async () => {
      const session = createSampleSession("u1", "s1");
      await storage.saveSession(session);

      // Mutate local object
      session.messages[0].content = "mutated locally";

      const loaded = await storage.loadSession("u1", "s1");
      expect(loaded?.messages[0].content).toBe("hello");
    });

    it("does not allow mutations on loaded session to affect stored data without update", async () => {
      const session = createSampleSession("u1", "s1");
      await storage.saveSession(session);

      const loaded = await storage.loadSession("u1", "s1");
      if (loaded) {
        loaded.messages.push({
          id: "m2",
          role: "assistant",
          content: "sneaky mutation",
          createdAt: 2000,
        });
      }

      const reloaded = await storage.loadSession("u1", "s1");
      expect(reloaded?.messages).toHaveLength(1);
    });
  });

  describe("Input validation and utility", () => {
    it("throws InvalidRequestError on invalid session data", async () => {
      // @ts-expect-error test invalid input
      await expect(storage.saveSession({})).rejects.toThrow(InvalidRequestError);
      // @ts-expect-error test invalid input
      await expect(storage.updateSession({ userId: "u1" })).rejects.toThrow(InvalidRequestError);
    });

    it("handles clear and size properly", async () => {
      await storage.saveSession(createSampleSession("u1", "s1"));
      await storage.saveSession(createSampleSession("u2", "s2"));
      expect(storage.size).toBe(2);

      await storage.clear();
      expect(storage.size).toBe(0);
      expect(await storage.loadSession("u1", "s1")).toBeNull();
    });
  });
});
