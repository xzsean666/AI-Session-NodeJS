import { AIClient } from "../dist/index.mjs";

async function main() {
  const ai = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "gpt-4o",
    },
  });

  // Create or load session
  const session = ai.session({
    userId: "user_1001",
    sessionId: "chat_001",
    system: "You are a concise programming assistant.",
  });

  // Turn 1
  console.log("User: Hello! What is TypeScript?");
  const reply1 = await session.chat("Hello! What is TypeScript?");
  console.log("Assistant:", reply1.content);

  // Turn 2: Continues conversation with previous context
  console.log("\nUser: Give me a quick code example.");
  const reply2 = await session.chat("Give me a quick code example.");
  console.log("Assistant:", reply2.content);

  // Inspect full history
  const history = await session.getHistory();
  console.log("\nFull message history count:", history.length);
}

main().catch(console.error);
