import type { IProvider } from "../provider/provider.js";
import type { Message } from "../types/message.js";
import { CompactError } from "../types/errors.js";

export const DEFAULT_COMPACT_PROMPT =
  "You are an expert conversation summarizer. Summarize the key facts, decisions, user preferences, context, and current task state from the conversation turns below. Be concise, objective, and dense with information. Do not invent details.";

/**
 * Executes conversation summarization using a unified AI Provider.
 */
export async function summarizeConversation(
  olderMessages: Message[],
  previousSummary: string | undefined,
  provider: IProvider,
  customPrompt = DEFAULT_COMPACT_PROMPT
): Promise<string> {
  if (!olderMessages || olderMessages.length === 0) {
    return previousSummary ?? "";
  }

  const conversationText = olderMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const promptContent = previousSummary
    ? `[PREVIOUS SUMMARY]\n${previousSummary}\n\n[NEW CONVERSATION TURNS TO COMPACT]\n${conversationText}\n\nPlease generate a unified, updated summary combining the previous summary and the new conversation turns.`
    : `[CONVERSATION TURNS TO COMPACT]\n${conversationText}\n\nPlease provide a concise summary of the conversation turns above.`;

  try {
    const response = await provider.chat({
      system: customPrompt,
      messages: [{ role: "user", content: promptContent }],
      temperature: 0.2,
    });

    if (!response.content || response.content.trim().length === 0) {
      throw new CompactError("Provider returned empty summary during compaction");
    }

    return response.content.trim();
  } catch (err: unknown) {
    if (err instanceof CompactError) {
      throw err;
    }
    throw new CompactError(
      `Failed to compact conversation context: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
