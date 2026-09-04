import type { IProvider } from "../provider/provider.js";
import type { SessionData } from "../types/session.js";
import type { ChatMessage } from "../types/provider.js";
import type { SessionContextBuilder } from "../session/session.js";
import {
  defaultTokenEstimator,
  estimateMessageTokens,
  type TokenEstimatorFn,
} from "./token-estimator.js";
import { summarizeConversation } from "../compact/compact-strategy.js";

export interface ContextManagerOptions {
  /**
   * Maximum token limit for the context window. Defaults to 4096.
   */
  maxContextTokens?: number;

  /**
   * Ratio of maxContextTokens that triggers automatic compaction (0.0 to 1.0). Defaults to 0.75.
   */
  compactThresholdRatio?: number;

  /**
   * Explicit token count threshold that triggers compaction. If specified, overrides compactThresholdRatio.
   */
  compactThresholdTokens?: number;

  /**
   * Number of recent messages to always retain uncompacted. Defaults to 4 (must be >= 2).
   */
  keepRecentMessages?: number;

  /**
   * Whether to automatically perform compaction when threshold is exceeded. Defaults to true.
   */
  autoCompact?: boolean;

  /**
   * Custom token estimator function.
   */
  tokenEstimator?: TokenEstimatorFn;

  /**
   * Custom summarization prompt template.
   */
  compactPrompt?: string;
}

/**
 * ContextManager projects Session history into an optimal token-budgeted Context window
 * and orchestrates automatic compaction when conversation approaches limits.
 */
export class ContextManager implements SessionContextBuilder {
  public readonly maxContextTokens: number;
  public readonly compactThresholdTokens: number;
  public readonly keepRecentMessages: number;
  public readonly autoCompact: boolean;
  private readonly tokenEstimator: TokenEstimatorFn;
  private readonly compactPrompt?: string;
  private readonly messageTokensCache = new WeakMap<object, number>();

  constructor(options: ContextManagerOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 4096;
    this.keepRecentMessages = Math.max(2, options.keepRecentMessages ?? 4);
    this.autoCompact = options.autoCompact ?? true;
    this.tokenEstimator = options.tokenEstimator ?? defaultTokenEstimator;
    this.compactPrompt = options.compactPrompt;

    if (options.compactThresholdTokens !== undefined) {
      this.compactThresholdTokens = options.compactThresholdTokens;
    } else {
      const ratio = options.compactThresholdRatio ?? 0.75;
      this.compactThresholdTokens = Math.floor(this.maxContextTokens * ratio);
    }
  }

  private getMessageTokens(msg: { role: string; content: string }): number {
    const cached = this.messageTokensCache.get(msg);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = estimateMessageTokens(msg, this.tokenEstimator);
    this.messageTokensCache.set(msg, tokens);
    return tokens;
  }

  /**
   * Estimate token usage for current session state.
   */
  calculateSessionTokens(session: SessionData): {
    systemTokens: number;
    summaryTokens: number;
    messagesTokens: number;
    totalTokens: number;
  } {
    const systemTokens = session.systemContext
      ? this.tokenEstimator(session.systemContext)
      : 0;

    const summaryTokens = session.summary
      ? this.tokenEstimator(session.summary) + 10 // extra overhead for summary framing
      : 0;

    let messagesTokens = 0;
    for (const msg of session.messages) {
      messagesTokens += this.getMessageTokens(msg);
    }

    const totalTokens = systemTokens + summaryTokens + messagesTokens;
    return {
      systemTokens,
      summaryTokens,
      messagesTokens,
      totalTokens,
    };
  }

  /**
   * Check if the session should undergo compaction based on token budget and message count.
   */
  shouldCompact(session: SessionData): boolean {
    const { totalTokens } = this.calculateSessionTokens(session);
    return (
      totalTokens >= this.compactThresholdTokens &&
      session.messages.length > this.keepRecentMessages
    );
  }

  /**
   * Build the prompt context for an upcoming provider chat request.
   * Triggers compact if threshold is exceeded and autoCompact is enabled.
   */
  async buildContext(
    session: SessionData,
    provider: IProvider
  ): Promise<{
    system?: string;
    messages: ChatMessage[];
    compacted: boolean;
  }> {
    let compacted = false;

    if (this.autoCompact && this.shouldCompact(session)) {
      const olderMessages = session.messages.slice(
        0,
        session.messages.length - this.keepRecentMessages
      );

      const newSummary = await summarizeConversation(
        olderMessages,
        session.summary,
        provider,
        this.compactPrompt
      );

      session.summary = newSummary;
      compacted = true;
    }

    // Build system prompt projection
    let systemProjection = session.systemContext;
    if (session.summary) {
      const summaryBlock = `[Previous Conversation Summary]\n${session.summary}`;
      systemProjection = systemProjection
        ? `${systemProjection}\n\n${summaryBlock}`
        : summaryBlock;
    }

    // Select messages for context window
    const candidateMessages = session.summary
      ? session.messages.slice(session.messages.length - this.keepRecentMessages)
      : session.messages;

    const projectedMessages: ChatMessage[] = [];
    const systemTokens = systemProjection ? this.tokenEstimator(systemProjection) : 0;
    let availableTokenBudget = this.maxContextTokens - systemTokens;

    // Fill candidate messages from newest backwards
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
      const msg = candidateMessages[i];
      const msgTokens = this.getMessageTokens(msg);
      if (availableTokenBudget - msgTokens >= 0 || projectedMessages.length === 0) {
        projectedMessages.unshift({
          role: msg.role,
          content: msg.content,
        });
        availableTokenBudget -= msgTokens;
      } else {
        break;
      }
    }

    return {
      system: systemProjection,
      messages: projectedMessages,
      compacted,
    };
  }
}
