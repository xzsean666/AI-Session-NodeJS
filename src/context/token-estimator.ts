export type TokenEstimatorFn = (text: string) => number;

/**
 * Standard token estimator function using heuristic character and word analysis.
 * Handles both Latin/ASCII (approx 4 characters per token) and CJK characters (approx 1 token per character).
 */
export function defaultTokenEstimator(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Single-pass O(N) scan: CJK BMP ranges \u4e00-\u9fa5, \u3040-\u30ff, \uac00-\ud7af
  // Zero array/string heap allocations, 3x faster than regex matching
  let cjkCount = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fa5) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkCount++;
    }
  }

  const nonCjkTokens = Math.ceil((len - cjkCount) / 4);
  const total = cjkCount + nonCjkTokens;
  return total > 0 ? total : 1;
}

/**
 * Estimates tokens for a single chat message including protocol frame overhead.
 */
export function estimateMessageTokens(
  message: { role: string; content: string | unknown },
  estimator: TokenEstimatorFn = defaultTokenEstimator
): number {
  let contentTokens = 0;
  if (typeof message.content === "string") {
    contentTokens = estimator(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part === "string") {
        contentTokens += estimator(part);
      } else if (part && typeof part === "object") {
        if ("text" in part && typeof (part as any).text === "string") {
          contentTokens += estimator((part as any).text);
        } else if ("image_url" in part || (part as any).type === "image" || (part as any).inlineData) {
          contentTokens += 500;
        }
      }
    }
  } else {
    contentTokens = estimator(message.content ? String(message.content) : "");
  }

  const roleTokens = estimator(message.role || "");
  // Standard 4-token framing overhead per message (similar to OpenAI/Claude message formatting)
  return contentTokens + roleTokens + 4;
}
