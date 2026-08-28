import { AIClient, type IStorage, type SessionData } from "../dist/index.mjs";

/**
 * Example of injecting a custom storage provider (e.g., Redis, SQLite, PostgreSQL).
 */
class CustomMapStorage implements IStorage {
  private db = new Map<string, string>();

  private key(userId: string, sessionId: string): string {
    return `session:${userId}:${sessionId}`;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.db.set(this.key(session.userId, session.sessionId), JSON.stringify(session));
  }

  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    const raw = this.db.get(this.key(userId, sessionId));
    return raw ? JSON.parse(raw) : null;
  }

  async updateSession(session: SessionData): Promise<void> {
    const k = this.key(session.userId, session.sessionId);
    if (!this.db.has(k)) {
      throw new Error(`Session not found: ${session.sessionId}`);
    }
    this.db.set(k, JSON.stringify(session));
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    return this.db.delete(this.key(userId, sessionId));
  }

  async listSessions(userId: string): Promise<SessionData[]> {
    const prefix = `session:${userId}:`;
    const sessions: SessionData[] = [];
    for (const [k, v] of this.db.entries()) {
      if (k.startsWith(prefix)) {
        sessions.push(JSON.parse(v));
      }
    }
    return sessions;
  }
}

async function main() {
  const customStorage = new CustomMapStorage();

  const ai = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.AI_API_KEY,
      model: "gpt-4o",
    },
    storage: customStorage,
  });

  const session = ai.session({
    userId: "enterprise_user",
    sessionId: "custom_storage_sess",
    system: "Enterprise helper",
  });

  console.log("Session initialized with custom storage provider.");
}

main().catch(console.error);
