import type { IStorage } from "../storage/storage.js";
import type { IProvider } from "../provider/provider.js";
import type { Message, MessageInput, MessageRole } from "../types/message.js";
import type {
  SessionData,
  SessionOptions,
  SessionChatOptions,
  SessionChatResult,
} from "../types/session.js";
import type { ProviderChunkResponse, ChatMessage } from "../types/provider.js";
import { InvalidRequestError } from "../types/errors.js";
import * as fs from "node:fs";
import {
  KnowledgeManager,
  type KnowledgeConfig,
  type SyncResult,
} from "../knowledge/knowledge-manager.js";

export interface SessionContextBuilder {
  buildContext(
    session: SessionData,
    provider: IProvider
  ): Promise<{
    system?: string;
    messages: ChatMessage[];
    compacted: boolean;
  }>;
}

/**
 * Session manages conversational state, persistence, and interactions for a single user/session.
 */
export class Session {
  public readonly userId: string;
  public readonly sessionId: string;
  private storage: IStorage;
  private provider: IProvider;
  private contextBuilder?: SessionContextBuilder;
  private initialSystem?: string;
  private initialMetadata?: Record<string, unknown>;
  private data?: SessionData;
  private knowledgeManager?: KnowledgeManager;

  constructor(options: {
    userId: string;
    sessionId: string;
    system?: string | KnowledgeConfig;
    systemContext?: string | KnowledgeConfig;
    metadata?: Record<string, unknown>;
    storage: IStorage;
    provider: IProvider;
    contextBuilder?: SessionContextBuilder;
  }) {
    if (!options.userId || !options.sessionId) {
      throw new InvalidRequestError("Session requires non-empty userId and sessionId");
    }
    this.userId = options.userId;
    this.sessionId = options.sessionId;
    this.initialMetadata = options.metadata;
    this.storage = options.storage;
    this.provider = options.provider;
    this.contextBuilder = options.contextBuilder;

    const rawSystem = options.systemContext ?? options.system;
    if (rawSystem && typeof rawSystem === "object" && "path" in rawSystem) {
      this.knowledgeManager = new KnowledgeManager(rawSystem, this.storage);
    } else if (typeof rawSystem === "string") {
      try {
        if (fs.existsSync(rawSystem)) {
          this.knowledgeManager = new KnowledgeManager({ path: rawSystem }, this.storage);
        } else {
          this.initialSystem = rawSystem;
        }
      } catch {
        this.initialSystem = rawSystem;
      }
    }
  }

  private generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Ensures the session data is loaded from storage or initialized.
   */
  private async ensureLoaded(): Promise<SessionData> {
    if (this.data) {
      return this.data;
    }

    const existing = await this.storage.loadSession(this.userId, this.sessionId);
    if (existing) {
      this.data = existing;
      if (this.initialSystem && !this.data.systemContext) {
        this.data.systemContext = this.initialSystem;
        await this.storage.saveSession(this.data);
      }
      return this.data;
    }

    const now = Date.now();
    const newData: SessionData = {
      userId: this.userId,
      sessionId: this.sessionId,
      systemContext: this.initialSystem,
      messages: [],
      summary: undefined,
      metadata: this.initialMetadata ? { ...this.initialMetadata } : {},
      createdAt: now,
      updatedAt: now,
    };

    await this.storage.saveSession(newData);
    this.data = newData;
    return this.data;
  }

  private normalizeMessageInput(input: MessageInput): Message {
    const now = Date.now();
    const id = this.generateId();

    if (typeof input === "string") {
      return {
        id,
        role: "user",
        content: input,
        createdAt: now,
      };
    }

    return {
      id,
      role: input.role || "user",
      content: input.content,
      createdAt: now,
      metadata: input.metadata,
    };
  }

  /**
   * Send a chat message, invoke the provider, persist the conversation, and return the result.
   */
  async chat(input: MessageInput, options?: SessionChatOptions): Promise<SessionChatResult> {
    const sessionData = await this.ensureLoaded();
    const userMessage = this.normalizeMessageInput(input);

    // Append user message to full history
    sessionData.messages.push(userMessage);
    sessionData.updatedAt = Date.now();

    let requestMessages: ChatMessage[];
    let systemPrompt = sessionData.systemContext;
    let compacted = false;

    if (this.knowledgeManager) {
      const { systemPrompt: dynamicSystem } = await this.knowledgeManager.buildSystemContext(userMessage.content);
      systemPrompt = dynamicSystem;
    }

    if (this.contextBuilder) {
      const context = await this.contextBuilder.buildContext(sessionData, this.provider);
      requestMessages = context.messages;
      if (context.system !== undefined && !this.knowledgeManager) {
        systemPrompt = context.system;
      }
      compacted = context.compacted;
    } else {
      requestMessages = sessionData.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    let response;
    try {
      response = await this.provider.chat({
        messages: requestMessages,
        system: systemPrompt,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
        customOptions: options?.customOptions,
      });
    } catch (err) {
      // Rollback user message if provider call fails to prevent dangling failed turns
      sessionData.messages.pop();
      throw err;
    }

    const assistantMessage: Message = {
      id: this.generateId(),
      role: "assistant",
      content: response.content,
      createdAt: Date.now(),
    };

    sessionData.messages.push(assistantMessage);
    sessionData.updatedAt = Date.now();

    await this.storage.saveSession(sessionData);

    return {
      message: assistantMessage,
      content: response.content,
      usage: response.usage,
      compacted,
    };
  }

  /**
   * Stream a chat response. Collects and persists the full assistant message upon completion.
   */
  async chatStream(
    input: MessageInput,
    options?: SessionChatOptions
  ): Promise<AsyncIterable<ProviderChunkResponse>> {
    const sessionData = await this.ensureLoaded();
    const userMessage = this.normalizeMessageInput(input);

    sessionData.messages.push(userMessage);
    sessionData.updatedAt = Date.now();

    let requestMessages: ChatMessage[];
    let systemPrompt = sessionData.systemContext;
    let compacted = false;

    if (this.knowledgeManager) {
      const { systemPrompt: dynamicSystem } = await this.knowledgeManager.buildSystemContext(userMessage.content);
      systemPrompt = dynamicSystem;
    }

    if (this.contextBuilder) {
      const context = await this.contextBuilder.buildContext(sessionData, this.provider);
      requestMessages = context.messages;
      if (context.system !== undefined && !this.knowledgeManager) {
        systemPrompt = context.system;
      }
      compacted = context.compacted;
    } else {
      requestMessages = sessionData.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    let stream: AsyncIterable<ProviderChunkResponse>;
    try {
      stream = await this.provider.chatStream({
        messages: requestMessages,
        system: systemPrompt,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
        customOptions: options?.customOptions,
      });
    } catch (err) {
      sessionData.messages.pop();
      throw err;
    }

    const self = this;

    return (async function* () {
      let fullContent = "";
      let finalUsage;

      try {
        for await (const chunk of stream) {
          if (chunk.delta) {
            fullContent += chunk.delta;
          }
          if (chunk.usage) {
            finalUsage = chunk.usage;
          }
          yield chunk;
        }

        const assistantMessage: Message = {
          id: self.generateId(),
          role: "assistant",
          content: fullContent,
          createdAt: Date.now(),
        };

        sessionData.messages.push(assistantMessage);
        sessionData.updatedAt = Date.now();
        await self.storage.saveSession(sessionData);
      } catch (err) {
        // In case stream throws during iteration, rollback user message
        sessionData.messages.pop();
        throw err;
      }
    })();
  }

  /**
   * Access attached KnowledgeManager instance, if configured.
   */
  getKnowledgeManager(): KnowledgeManager | undefined {
    return this.knowledgeManager;
  }

  /**
   * Explicitly trigger knowledge synchronization for this session's knowledge base.
   */
  async syncKnowledge(): Promise<SyncResult | undefined> {
    if (this.knowledgeManager) {
      return this.knowledgeManager.sync();
    }
    return undefined;
  }

  /**
   * Get the complete message history for this session.
   */
  async getHistory(): Promise<Message[]> {
    const data = await this.ensureLoaded();
    return structuredClone(data.messages);
  }

  /**
   * Get the current compact summary, if any exists.
   */
  async getSummary(): Promise<string | undefined> {
    const data = await this.ensureLoaded();
    return data.summary;
  }

  /**
   * Get metadata associated with this session.
   */
  async getMetadata(): Promise<Record<string, unknown>> {
    const data = await this.ensureLoaded();
    return structuredClone(data.metadata ?? {});
  }

  /**
   * Update metadata for this session.
   */
  async updateMetadata(metadata: Record<string, unknown>): Promise<void> {
    const data = await this.ensureLoaded();
    data.metadata = { ...data.metadata, ...metadata };
    data.updatedAt = Date.now();
    await this.storage.saveSession(data);
  }

  /**
   * Clear conversation history while retaining session identity and systemContext.
   */
  async clearHistory(): Promise<void> {
    const data = await this.ensureLoaded();
    data.messages = [];
    data.summary = undefined;
    data.updatedAt = Date.now();
    await this.storage.saveSession(data);
  }

  /**
   * Delete this session from storage.
   */
  async delete(): Promise<boolean> {
    const deleted = await this.storage.deleteSession(this.userId, this.sessionId);
    this.data = undefined;
    return deleted;
  }

  /**
   * Return complete raw SessionData snapshot.
   */
  async getData(): Promise<SessionData> {
    const data = await this.ensureLoaded();
    return structuredClone(data);
  }
}
