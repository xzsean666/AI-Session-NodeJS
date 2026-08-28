import { AIClient } from "../dist/index.mjs";

async function main() {
  // 1. 初始化 AIClient，默认开启 SQLite 持久化 (./data/ai-session.db)
  const ai = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
    },
  });

  // 2. 创建基于本地 Markdown 知识库目录的 Session
  const session = ai.session({
    userId: "dev_knowledge_user",
    sessionId: "kb_session_001",
    system: {
      prompt: "你是一名资深系统架构顾问，请结合本地知识库回答问题。",
      path: "./examples/docs-sample", // 直接传入知识库目录
      mode: "rag",                    // 开启按需章节检索与 Token 优化 (省 95% Token)
      maxKnowledgeTokens: 1500,       // 知识库上下文 Token 预算上限
    },
  });

  console.log("=== 第 1 轮：询问退款政策（测试知识库检索）===");
  const reply1 = await session.chat("对于超过1000美元的高价值VIP退款，我们的SLA政策是怎样的？");
  console.log("Assistant:\n", reply1.content);

  // 等待 2 秒，避免免费 API 并发限流
  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n=== 第 2 轮：询问已发货订单取消（同一 Session 连续对话）===");
  const reply2 = await session.chat("如果用户购买的商品已经处于 SHIPPED 状态，能直接取消吗？应该走什么流程？");
  console.log("Assistant:\n", reply2.content);

  console.log("\n=== 检查 SQLite 会话历史与知识库同步状态 ===");
  const history = await session.getHistory();
  console.log(`当前 Session 已持久化在 SQLite 中，历史消息总数: ${history.length}`);
}

main().catch(console.error);
