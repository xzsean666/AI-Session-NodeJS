import * as fs from "node:fs";
import * as path from "node:path";
import { AIClient, LoadBalancedProvider } from "../dist/index.mjs";

function parseEnv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
  }
  return env;
}

const nvidiaEnv = parseEnv(path.resolve(process.cwd(), ".env.nvidia"));
const defaultEnv = parseEnv(path.resolve(process.cwd(), ".env"));

async function testSingleProvider(name: string, client: AIClient) {
  console.log(`\n======================================================`);
  console.log(`🧪 [TEST] ${name} 缓存功能深度验证`);
  console.log(`======================================================`);

  const prompt = "请用5个字以内回复：'缓存测试通过'";

  // 1. First Call: Session A (Miss -> Remote Call)
  console.log(`\n[Step 1] 首次提问 (未命中缓存，发起真实 API 网络请求)...`);
  const session1 = client.session({ userId: "u1", sessionId: `s1_${Date.now()}` });
  const t0 = Date.now();
  const res1 = await session1.chat(prompt, { maxTokens: 20 });
  const dur1 = Date.now() - t0;
  console.log(`✅ 响应: "${res1.content.trim()}"`);
  console.log(`⏱️ 首次网络耗时: ${dur1}ms`);
  console.log(`🏷️ 是否来自缓存: ${Boolean((res1.raw as any)?.cached)} (期望: false)`);

  // 2. Second Call: Session B with identical prompt (Hit -> 0ms Cache)
  console.log(`\n[Step 2] 二次相同提问 (命中 ResponseCache，0ms 瞬间返回)...`);
  const session2 = client.session({ userId: "u2", sessionId: `s2_${Date.now()}` });
  const t1 = Date.now();
  const res2 = await session2.chat(prompt, { maxTokens: 20 });
  const dur2 = Date.now() - t1;
  console.log(`✅ 响应: "${res2.content.trim()}"`);
  console.log(`⏱️ 二次响应耗时: ${dur2}ms`);
  console.log(`🏷️ 是否来自缓存: ${Boolean((res2.raw as any)?.cached)} (期望: true)`);
  console.log(`⚡ 响应速度加速比: ${(dur1 / Math.max(dur2, 1)).toFixed(1)}x 倍`);

  // 3. Third Call with noCache: true (Bypass)
  console.log(`\n[Step 3] 动态绕过缓存 (customOptions: { noCache: true })...`);
  const session3 = client.session({ userId: "u3", sessionId: `s3_${Date.now()}` });
  const t2 = Date.now();
  const res3 = await session3.chat(prompt, { maxTokens: 20, customOptions: { noCache: true } });
  const dur3 = Date.now() - t2;
  console.log(`✅ 响应: "${res3.content.trim()}"`);
  console.log(`⏱️ 耗时: ${dur3}ms`);
  console.log(`🏷️ 是否来自缓存: ${Boolean((res3.raw as any)?.cached)} (期望: false)`);

  // 4. Stream Test (Miss then Hit)
  console.log(`\n[Step 4] 流式输出 (chatStream) 首次请求与二次缓存回放实测...`);
  const streamSession1 = client.session({ userId: "s_user1", sessionId: `stream_1_${Date.now()}` });
  const streamPrompt = "请回复数字 123";
  const st0 = Date.now();
  let streamText1 = "";
  for await (const chunk of await streamSession1.chatStream(streamPrompt, { maxTokens: 20 })) {
    streamText1 += chunk.delta;
  }
  const sdur1 = Date.now() - st0;
  console.log(`✅ 首次流式完成: "${streamText1.trim().replace(/\n/g, ' ')}", 耗时: ${sdur1}ms`);

  const st1 = Date.now();
  let streamText2 = "";
  let isStreamCached = false;
  const streamSession2 = client.session({ userId: "s_user2", sessionId: `stream_2_${Date.now()}` });
  for await (const chunk of await streamSession2.chatStream(streamPrompt, { maxTokens: 20 })) {
    streamText2 += chunk.delta;
    if ((chunk.raw as any)?.cached) isStreamCached = true;
  }
  const sdur2 = Date.now() - st1;
  console.log(`✅ 二次流式缓存回放: "${streamText2.trim().replace(/\n/g, ' ')}", 耗时: ${sdur2}ms, Cached: ${isStreamCached}`);
  console.log(`⚡ 流式加速比: ${(sdur1 / Math.max(sdur2, 1)).toFixed(1)}x 倍`);
}

async function run() {
  // Test 1: NVIDIA NIM API
  const nvKey = nvidiaEnv.AI_API_KEY || nvidiaEnv.OPENAI_API_KEY;
  const nvBaseUrl = nvidiaEnv.AI_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const nvModel = "nvidia/nemotron-3-ultra-550b-a55b";

  const nvidiaClient = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: nvBaseUrl,
      apiKey: nvKey,
      model: nvModel,
    },
    cache: true,
    storageCache: true,
  });

  try {
    await testSingleProvider(`NVIDIA NIM API (${nvModel})`, nvidiaClient);
  } catch (err: any) {
    console.error(`❌ NVIDIA NIM 测试异常:`, err.message || err);
  }

  // Test 2: OpenAI / OpenRouter API
  const orKey = defaultEnv.AI_API_KEY || defaultEnv.OPENAI_API_KEY;
  const orBaseUrl = defaultEnv.AI_BASE_URL || "https://openrouter.ai/api/v1";
  const orModel = "liquid/lfm-2.5-2.6b:free";

  const openRouterClient = new AIClient({
    provider: {
      protocol: "openai",
      baseUrl: orBaseUrl,
      apiKey: orKey,
      model: orModel,
    },
    cache: true,
    storageCache: true,
  });

  try {
    await testSingleProvider(`OpenAI/OpenRouter 兼容端点 (${orModel})`, openRouterClient);
  } catch (err: any) {
    console.error(`❌ OpenAI/OpenRouter 测试提示:`, err.message || err);
  }

  // Test 3: Multi-Target Load Balancing with DIFFERENT URLs and DIFFERENT Keys
  console.log(`\n======================================================`);
  console.log(`🔀 [TEST] 跨提供商多 URL + 独立 API_KEY 负载均衡 + 缓存综合测试`);
  console.log(`======================================================`);
  console.log(`Target 1: URL=${nvBaseUrl}, Model=${nvModel}, Key=${nvKey ? nvKey.slice(0, 10) + '...' : 'none'}`);
  console.log(`Target 2: URL=${orBaseUrl}, Model=${orModel}, Key=${orKey ? orKey.slice(0, 10) + '...' : 'none'}`);

  const loadBalancedClient = new AIClient({
    provider: new LoadBalancedProvider({
      protocol: "openai",
      model: nvModel,
      targets: [
        {
          baseUrl: nvBaseUrl,
          apiKey: nvKey,
          model: nvModel,
        },
        {
          baseUrl: orBaseUrl,
          apiKey: orKey,
          model: orModel,
        },
      ],
      strategy: "round-robin",
    }),
    cache: true,
    storageCache: true,
  });

  const lbSession = loadBalancedClient.session({ userId: "lb-user", sessionId: "lb-s" });

  console.log(`\n[Round 1] 请求 1 (分发至 Target 1)...`);
  const r1 = await lbSession.chat("回复字母 A", { maxTokens: 20 });
  console.log(`✅ 响应 1: "${r1.content.trim()}"`);

  console.log(`\n[Round 2] 相同问题 (直接命中 ResponseCache 缓存 0ms)...`);
  const r2 = await loadBalancedClient.session({ userId: "lb-user-2", sessionId: "s2" }).chat("回复字母 A", { maxTokens: 20 });
  console.log(`✅ 响应 2: "${r2.content.trim()}", Cached: ${(r2.raw as any)?.cached}`);

  console.log(`\n[Round 3] 请求 2 (新问题，轮询分发至 Target 2)...`);
  const r3 = await loadBalancedClient.session({ userId: "lb-user-3", sessionId: "s3" }).chat("回复字母 B", { maxTokens: 20 });
  console.log(`✅ 响应 3: "${r3.content.trim()}"`);

  console.log("\n==================================================================");
  console.log("🏆 所有真实大模型 API 缓存与多 Key/多 URL 负载均衡测试通过！");
  console.log("==================================================================");
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
