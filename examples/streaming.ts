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

  const session = ai.session({
    userId: "user_stream",
    sessionId: "stream_session_1",
    system: "You are a creative writer.",
  });

  process.stdout.write("Assistant: ");
  const stream = await session.chatStream("Write a short haiku about coding.");

  for await (const chunk of stream) {
    if (chunk.delta) {
      process.stdout.write(chunk.delta);
    }
  }
  process.stdout.write("\n\n");

  // Verify stream response was automatically persisted
  const history = await session.getHistory();
  console.log("Persisted messages:", history.length);
}

main().catch(console.error);
