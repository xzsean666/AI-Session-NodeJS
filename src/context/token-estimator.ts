export type TokenEstimatorFn = (text: string) => number;

/**
 * Standard token estimator function using heuristic character and word analysis.
 * Handles both Latin/ASCII (approx 4 characters per token) and CJK characters (approx 1 token per character).
 */
export function defaultTokenEstimator(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Match CJK character range: \u4e00-\u9fa5, Japanese Hiragana/Katakana \u3040-\u30ff, Korean Hangul \uac00-\ud7af
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK characters from the text to count remaining characters
  const nonCjkText = text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, "");
  const nonCjkTokens = Math.ceil(nonCjkText.length / 4);

  const total = cjkCount + nonCjkTokens;
  return total > 0 ? total : 1;
}

/**
 * Estimates tokens for a single chat message including protocol frame overhead.
 */
export function estimateMessageTokens(
  message: { role: string; content: string },
  estimator: TokenEstimatorFn = defaultTokenEstimator
): number {
  const contentTokens = estimator(message.content || "");
  const roleTokens = estimator(message.role || "");
  // Standard 4-token framing overhead per message (similar to OpenAI/Claude message formatting)
  return contentTokens + roleTokens + 4;
}
