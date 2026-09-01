import { AIClient, LoadBalancedProvider } from "../src/index.js";

/**
 * 示例 1: OpenAI 系列模型（官方直连为主，中转 API 为备）
 * 策略: "priority" (主备模式 - 优先走官方，官方 429/宕机/限流时毫秒级自动切中转)
 */
export function createOpenAIClient() {
  return new AIClient({
    provider: {
      protocol: "openai",
      model: "gpt-4o",
      // 同一模型系列，多个不同 BaseURL 与独立 API Key
      endpoints: [
        {
          // 主线路：OpenAI 官方直连
          baseUrl: "https://api.openai.com/v1",
          apiKey: process.env.OPENAI_API_KEY_OFFICIAL,
        },
        {
          // 备用线路 1：国内中转 API 1
          baseUrl: "https://relay-1.example.com/v1",
          apiKey: process.env.RELAY_1_API_KEY,
        },
        {
          // 备用线路 2：备用中转 API 2
          baseUrl: "https://relay-2.example.com/v1",
          apiKey: process.env.RELAY_2_API_KEY,
        },
      ],
      loadBalance: {
        strategy: "priority", // 主备模式：始终优先第1条，故障/限流自动降级切后续中转
        cooldownMs: 30000,    // 故障线路冷却 30 秒后自动重新尝试
        maxRetries: 3,        // 自动重试最大次数
      },
    },
    // 无论走官方还是中转，全局共享双层缓存体系
    cache: true,              // L2 响应级 0ms 缓存
    storageCache: true,       // L1 会话内存缓存
  });
}

/**
 * 示例 2: NVIDIA 系列模型（官方 NIM 直连为主，OpenRouter / 聚合服务为备）
 * 应对不同中转站模型名称略有差异的情况（如 OpenRouter 模型 ID 格式）
 */
export function createNvidiaClient() {
  return new AIClient({
    provider: {
      protocol: "openai",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      endpoints: [
        {
          // 主线路：NVIDIA 官方 NIM API
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: process.env.NVIDIA_API_KEY,
          model: "nvidia/llama-3.1-nemotron-70b-instruct",
        },
        {
          // 备用线路：OpenRouter 聚合平台（中转名称适配）
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: process.env.OPENROUTER_API_KEY,
          model: "nvidia/llama-3.1-nemotron-70b-instruct", // 或第三方特定模型标识
        },
      ],
      loadBalance: {
        strategy: "priority",
        cooldownMs: 30000,
      },
    },
    cache: true,
    storageCache: true,
  });
}

/**
 * 示例 3: 运行中动态热切换 Key / 中转 BaseURL（零影响、不丢 Session、不丢缓存）
 */
export async function dynamicKeySwitchingExample() {
  const client = createOpenAIClient();

  // 1. 发起会话对话
  const session = client.session({ userId: "user-100", sessionId: "session-abc" });
  await session.chat("你好！");

  // 2. 运维场景：动态轮换中转 API 节点或更新已失效的 Key
  // 获取底层负载均衡器，执行热更新
  const provider = client.getProvider();
  if (provider instanceof LoadBalancedProvider) {
    provider.updateTargets([
      {
        baseUrl: "https://new-relay.example.com/v1",
        apiKey: "sk-new-relay-key-xyz",
      },
    ]);
  }

  // 3. 业务代码无感继续对话（历史会话与上下文完全保留）
  const res = await session.chat("请帮我总结刚才的内容");
  console.log("切换后继续对话正常:", res.content);
}
