import { AIClient } from "../dist/index.mjs";

// 1. OpenAI Compatible (Works with OpenAI, LiteLLM, Ollama, vLLM, DeepSeek, etc.)
export const openaiClient = new AIClient({
  provider: {
    protocol: "openai",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
  },
});

// 2. Anthropic Claude
export const anthropicClient = new AIClient({
  provider: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-3-5-sonnet-20241022",
  },
});

// 3. Google Gemini
export const geminiClient = new AIClient({
  provider: {
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-1.5-pro",
  },
});
