import { AIClient } from "../dist/index.mjs";

async function main() {
  const ai = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
    },
    // 可自定义上下文压缩策略与 Token 预算
    context: {
      maxContextTokens: 4096,
      keepRecentMessages: 4, // 压缩时保留最近 4 条消息
      autoCompact: true,     // 达到预算时自动对旧对话生成摘要，支持一直聊
    },
  });

  // 1. 项目上下文与 System Prompt 注入
  const projectContext = `
【项目名称】：E-Commerce Order Service
【技术栈】：Node.js, TypeScript, PostgreSQL, Redis
【核心业务规则】：
1. 订单状态包括：PENDING, PAID, SHIPPED, COMPLETED, CANCELLED
2. 只有处于 PENDING 状态的订单才能被取消 (CANCELLED)
3. 用户每次下单必须校验库存并在 Redis 中做 15 分钟的分布式锁定
`;

  const session = ai.session({
    userId: "dev_user_01",
    sessionId: "order_service_discussion",
    system: `你是一名资深的 Node.js 架构师。请结合以下项目上下文回答问题：\n${projectContext}`,
  });

  console.log("=== 第 1 轮：询问项目架构业务规则 ===");
  const reply1 = await session.chat("已发货的订单(SHIPPED)用户可以申请直接取消吗？依据是什么？");
  console.log("Assistant:", reply1.content);

  console.log("\n=== 第 2 轮：基于上下文继续深聊（同一 Session）===");
  const reply2 = await session.chat("那在这个项目中，如果用户刚下单处于 PENDING，我们应该如何利用 Redis 锁定库存？请给出 TypeScript 代码片段。");
  console.log("Assistant:", reply2.content);

  console.log("\n=== 第 3 轮：检查会话历史与持久化 ===");
  const history = await session.getHistory();
  console.log(`当前 Session 共持久化了 ${history.length} 条消息。`);
}

main().catch(console.error);
