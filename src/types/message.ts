export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export type MessageInput =
  | string
  | {
      role?: MessageRole;
      content: string;
      metadata?: Record<string, unknown>;
    };
