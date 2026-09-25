export type MessageRole = "system" | "user" | "assistant";

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type MessageContentPart =
  | TextContentPart
  | ImageUrlContentPart
  | { type: string; [key: string]: unknown };

export type MessageContent = string | MessageContentPart[];

export interface Message {
  id: string;
  role: MessageRole;
  content: MessageContent;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export type MessageInput =
  | string
  | {
      role?: MessageRole;
      content: MessageContent;
      metadata?: Record<string, unknown>;
    };

/**
 * Helper to safely extract textual content from string, array of parts, or structured objects.
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if ("text" in part && typeof (part as any).text === "string") {
            return (part as any).text;
          }
        }
        return "";
      })
      .filter((t) => t.length > 0)
      .join(" ");
  }
  if (content && typeof content === "object" && "text" in content && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  return content ? String(content) : "";
}
