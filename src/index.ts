/**
 * AI Session SDK
 * A resilient Node.js/TypeScript AI Session SDK with automatic history persistence and context compaction.
 */

export const VERSION = "0.1.0";

// Types
export * from "./types/message.js";
export * from "./types/session.js";
export * from "./types/provider.js";
export * from "./types/errors.js";

// Storage
export * from "./storage/storage.js";
export * from "./storage/memory-storage.js";
export * from "./storage/sqlite-storage.js";

// Knowledge Base & Chunker
export * from "./knowledge/markdown-chunker.js";
export * from "./knowledge/code-skeleton.js";
export * from "./knowledge/knowledge-manager.js";

// Provider
export * from "./provider/provider.js";
export * from "./provider/provider-manager.js";
export * from "./provider/utils.js";
export * from "./provider/openai-compatible.js";
export * from "./provider/anthropic.js";
export * from "./provider/gemini.js";

// Context & Compaction
export * from "./context/token-estimator.js";
export * from "./context/context-manager.js";
export * from "./compact/compact-strategy.js";

// Session & Client
export * from "./session/session.js";
export * from "./client/ai-client.js";
