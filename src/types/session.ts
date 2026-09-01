import type { Message } from "./message.js";
import type { KnowledgeConfig } from "../knowledge/knowledge-manager.js";

export interface SessionData {
  userId: string;
  sessionId: string;
  systemContext?: string;
  messages: Message[];
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionOptions {
  userId: string;
  sessionId: string;
  /**
   * System prompt string, path to a markdown/code file or directory, or KnowledgeConfig.
   */
  system?: string | KnowledgeConfig;
  /**
   * System prompt string or KnowledgeConfig (alias for system).
   */
  systemContext?: string | KnowledgeConfig;
  metadata?: Record<string, unknown>;
}

export interface SessionChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  customOptions?: Record<string, unknown>;
}

export interface SessionChatResult {
  message: Message;
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  compacted?: boolean;
  cached?: boolean;
  raw?: unknown;
}
