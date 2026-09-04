import { AIClient, LoadBalancedProvider } from "../dist/index.mjs";

// 示例 1：使用 LoadBalancedProvider 配置多个 OpenAI API Key 进行轮询分流与 429 容灾
const clientWithKeyPool = new AIClient({
  provider: new LoadBalancedProvider({
    protocol: "openai",
    model: "gpt-4o",
    targets: [
      { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_KEY_1 || "sk-key-1" },
      { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_KEY_2 || "sk-key-2" },
      { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_KEY_3 || "sk-key-3" },
    ],
    strategy: "round-robin",
    cooldownMs: 30000, // 429 限流时该 Key 冷却 30 秒并自动切换下一个
  }),
  // 开启响应级缓存：相同提问 0ms 瞬间返回，0 Token 开销（支持 stream 回放）
  cache: true,
  // 开启 L1 进程内存缓存：减少 SQLite 磁盘读写与 JSON 反序列化延迟
  storageCache: true,
});

// 示例 2：使用配置语法糖（自动创建 LoadBalancedProvider）并开启 sessionAffinity 会话锁定
const clusterClient = new AIClient({
  provider: {
    protocol: "openai",
    model: "deepseek-r1",
    baseUrls: [
      "http://gpu-worker-1:8000/v1",
      "http://gpu-worker-2:8000/v1",
      "http://gpu-worker-3:8000/v1",
    ],
    apiKey: "shared-cluster-token",
    loadBalance: {
      strategy: "round-robin",
      cooldownMs: 15000,
      sessionAffinity: true, // 开启会话亲和性：同一个 session 始终锁定同一台 GPU Worker！
      repinOnFailover: true, // 遭遇 429/故障时自动容灾切换并重新绑定新健康 Worker
    },
  },
  cache: {
    ttlMs: 10 * 60 * 1000, // 缓存 10 分钟
    maxEntries: 500,
  },
});

// 示例 3：显式锁定某个会话到指定节点 (Manual Target Pinning)
function createPinnedSessionDemo() {
  const session = clusterClient.session({
    userId: "enterprise-user",
    sessionId: "vip-session-001",
    // 也可以在创建时显式指定 pin 到某个特定 worker
    pinnedTarget: "http://gpu-worker-2:8000/v1",
  });

  console.log("VIP Session 已锁定到:", session.getPinnedTargetInfo()?.baseUrl);
  return session;
}

async function main() {
  const session = clientWithKeyPool.session({
    userId: "user-dev",
    sessionId: "session-lb-demo",
  });

  console.log("--- 第一次提问 (走 LLM API 节点分发) ---");
  const t1 = Date.now();
  const res1 = await session.chat("请用一句话介绍负载均衡的好处。");
  console.log(`耗时: ${Date.now() - t1}ms`);
  console.log(`响应节点: ${res1.target?.baseUrl}`);
  console.log(`回答: ${res1.content}`);

  console.log("\n--- 第二次提问相同问题 (命中 Response Cache 缓存) ---");
  const t2 = Date.now();
  const res2 = await session.chat("请用一句话介绍负载均衡的好处。");
  console.log(`耗时: ${Date.now() - t2}ms (命中缓存: ${res2.cached})`);
  console.log(`回答: ${res2.content}`);

  console.log("\n--- 会话锁定演示 (Session Pinning / Sticky Session) ---");
  const pinnedSession = clusterClient.session({
    userId: "user-cache-demo",
    sessionId: "sticky-session-123",
  });

  console.log("当前会话锁定节点:", pinnedSession.getPinnedTargetInfo()?.baseUrl ?? "首次请求后自动锁定");
}

if (process.env.RUN_EXAMPLE) {
  main().catch(console.error);
}
