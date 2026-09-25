import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AIClient } from "../../dist/index.mjs";
import {
  PALM_FACE_READING_SYSTEM_PROMPT,
  buildFaceReadingPrompt,
  buildPalmReadingPrompt,
  buildCombinedReadingPrompt,
} from "./prompts.ts";
import {
  createMultimodalMessage,
  createCombinedMultimodalMessage,
  inspectImage,
  PHOTO_CAPTURE_TIPS,
  type ImageInput,
} from "./image-utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 创建相术专业 AI Client 与 Session 实例
 */
export function createReadingSession(options?: {
  userId?: string;
  sessionId?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}) {
  const knowledgePath = path.resolve(__dirname, "knowledge");

  const ai = new AIClient({
    provider: {
      protocol: (process.env.AI_PROVIDER_PROTOCOL as any) || "openai",
      baseUrl: options?.baseUrl || process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
      apiKey: options?.apiKey || process.env.AI_API_KEY || "demo-key",
      model: options?.model || process.env.AI_MODEL || "meta/llama-3.2-90b-vision-instruct",
    },
  });

  const session = ai.session({
    userId: options?.userId || "palm_face_user_01",
    sessionId: options?.sessionId || `session_${Date.now()}`,
    system: {
      prompt: PALM_FACE_READING_SYSTEM_PROMPT,
      path: knowledgePath,
      mode: "rag",
      maxKnowledgeTokens: 2800, // 知识库 RAG 注入上限，兼顾古籍深度与上下文经济
      searchLimit: 10,
    },
  });

  return { ai, session, knowledgePath };
}

/**
 * 分析单张面相（支持传入本地图片路径、网络图片 URL 或面貌特征描述）
 */
export async function analyzeFace(
  session: ReturnType<typeof createReadingSession>["session"],
  input: {
    imagePathOrUrl?: string;
    textDescription?: string;
    notes?: string;
  }
) {
  let promptText = buildFaceReadingPrompt(input.notes);
  if (input.textDescription) {
    promptText += `\n\n【当事人面貌特征描述】：\n${input.textDescription}`;
  }

  const messageContent = createMultimodalMessage(
    promptText,
    input.imagePathOrUrl
      ? { pathOrUrl: input.imagePathOrUrl, label: "当事人面相照片" }
      : undefined
  );

  const response = await session.chat({
    role: "user",
    content: messageContent,
  });

  return response.content;
}

/**
 * 分析单张手相（支持传入本地手掌照片路径、图片 URL 或手纹特征描述）
 */
export async function analyzePalm(
  session: ReturnType<typeof createReadingSession>["session"],
  input: {
    imagePathOrUrl?: string;
    textDescription?: string;
    notes?: string;
  }
) {
  let promptText = buildPalmReadingPrompt(input.notes);
  if (input.textDescription) {
    promptText += `\n\n【当事人手掌特征描述】：\n${input.textDescription}`;
  }

  const messageContent = createMultimodalMessage(
    promptText,
    input.imagePathOrUrl
      ? { pathOrUrl: input.imagePathOrUrl, label: "当事人手相照片" }
      : undefined
  );

  const response = await session.chat({
    role: "user",
    content: messageContent,
  });

  return response.content;
}

/**
 * 【面手双图合参】：同时传入面相照片与手相照片进行综合深度批断
 */
export async function analyzeCombined(
  session: ReturnType<typeof createReadingSession>["session"],
  input: {
    faceImage?: string;
    palmImage?: string;
    leftPalmImage?: string;
    rightPalmImage?: string;
    images?: ImageInput;
    textDescription?: string;
    notes?: string;
  }
) {
  let promptText = buildCombinedReadingPrompt(input.notes);
  if (input.textDescription) {
    promptText += `\n\n【当事人相貌与手纹补充描述】：\n${input.textDescription}`;
  }

  let messageContent;

  if (input.faceImage || input.palmImage || input.leftPalmImage || input.rightPalmImage) {
    messageContent = createCombinedMultimodalMessage({
      textPrompt: promptText,
      faceImage: input.faceImage,
      palmImage: input.palmImage,
      leftPalmImage: input.leftPalmImage,
      rightPalmImage: input.rightPalmImage,
    });
  } else if (input.images) {
    messageContent = createMultimodalMessage(promptText, input.images);
  } else {
    messageContent = promptText;
  }

  const response = await session.chat({
    role: "user",
    content: messageContent,
  });

  return response.content;
}

/**
 * 主执行流程：支持多图合参、单图分析与 CLI 命令行调用
 */
async function main() {
  console.log("==================================================================");
  console.log(" 🔮 东方相学大宗师：面相与手相智能分析系统 (基于 RAG 知识库)");
  console.log("==================================================================");

  const { session, knowledgePath } = createReadingSession();
  console.log(`[1] 正在同步并索引相术核心知识库: ${knowledgePath}`);

  // 显式触发知识库同步并打印统计
  const syncResult = await session.syncKnowledge();
  console.log(
    `    ✓ 知识库同步完成: 共索引 ${syncResult.totalFiles} 个古籍与相法文档，解析为 ${syncResult.totalChunks} 个精细知识切片 (FTS5)。`
  );

  // 解析 CLI 参数
  const args = process.argv.slice(2);
  if (args.includes("--tips") || args.includes("-t")) {
    console.log("\n" + PHOTO_CAPTURE_TIPS);
    return;
  }

  const faceArgIndex = args.indexOf("--face");
  const palmArgIndex = args.indexOf("--palm");

  const faceImg = faceArgIndex !== -1 ? args[faceArgIndex + 1] : undefined;
  const palmImg = palmArgIndex !== -1 ? args[palmArgIndex + 1] : undefined;

  // 场景 A：同时传入了面相图片与手相图片 -> 触发【面手双图合参】
  if (faceImg && palmImg) {
    const faceInfo = inspectImage(faceImg);
    const palmInfo = inspectImage(palmImg);

    console.log(`\n[2] 正在执行【面手双图合参】(多模态深度解读)：`);
    console.log(`    - 面相图片: ${faceImg} [${faceInfo.mimeType}, ${faceInfo.sizeMb ? faceInfo.sizeMb + " MB" : "在线URL"}]`);
    if (faceInfo.warning) console.log(`      ⚠️  ${faceInfo.warning}`);
    console.log(`    - 手相图片: ${palmImg} [${palmInfo.mimeType}, ${palmInfo.sizeMb ? palmInfo.sizeMb + " MB" : "在线URL"}]`);
    if (palmInfo.warning) console.log(`      ⚠️  ${palmInfo.warning}`);

    try {
      const result = await analyzeCombined(session, {
        faceImage: faceImg,
        palmImage: palmImg,
      });
      console.log("\n【大宗师面手合参批示】：\n", result);
    } catch (err: any) {
      console.log(`(API 调用说明: ${err.message})`);
    }
    return;
  }

  // 场景 B：仅传入面相图片
  if (faceImg) {
    const faceInfo = inspectImage(faceImg);
    console.log(`\n[2] 正在分析指定的面相图片: ${faceImg} [${faceInfo.mimeType}, ${faceInfo.sizeMb ? faceInfo.sizeMb + " MB" : "在线URL"}]`);
    if (faceInfo.warning) console.log(`    ⚠️  ${faceInfo.warning}`);

    try {
      const result = await analyzeFace(session, { imagePathOrUrl: faceImg });
      console.log("\n【大宗师面相批示】：\n", result);
    } catch (err: any) {
      console.log(`(API 调用说明: ${err.message})`);
    }
    return;
  }

  // 场景 C：仅传入手相图片
  if (palmImg) {
    const palmInfo = inspectImage(palmImg);
    console.log(`\n[2] 正在分析指定的手相图片: ${palmImg} [${palmInfo.mimeType}, ${palmInfo.sizeMb ? palmInfo.sizeMb + " MB" : "在线URL"}]`);
    if (palmInfo.warning) console.log(`    ⚠️  ${palmInfo.warning}`);

    try {
      const result = await analyzePalm(session, { imagePathOrUrl: palmImg });
      console.log("\n【大宗师手相批示】：\n", result);
    } catch (err: any) {
      console.log(`(API 调用说明: ${err.message})`);
    }
    return;
  }

  // 默认演示模式：模拟包含单面相、单手相以及【面手双图合参】的全流程
  console.log("\n[演示示例 1]：面相特征分析（测试天庭高广、悬胆鼻、卧蚕丰满、仰月口）");
  console.log("------------------------------------------------------------------");
  const faceTestInput = {
    textDescription:
      "男性，32岁。天庭高广饱满且平整如璧，发际线整齐微呈方额；眉毛清秀长过目，眉眼间田宅宫开阔明亮，印堂宽约两指；眼有神采，黑白分明，双眼下有明显饱满卧蚕；鼻梁挺直无起节，准头丰隆圆润如悬胆，两侧鼻翼厚实收敛不见鼻孔；嘴角自然微翘呈仰月口，下巴方圆微前兜。",
    notes: "目前在科技企业担任架构师，正在考虑是否要独立创业。",
  };

  try {
    const faceAnalysis = await analyzeFace(session, faceTestInput);
    console.log("\n【大宗师面相精析】：\n", faceAnalysis);
  } catch (err: any) {
    console.log(`(注：若未配置可用 AI_API_KEY，此处展示 API 调用报错说明: ${err.message})`);
  }

  console.log("\n[演示示例 2]：手相特征分析（测试川字掌、双重生命线、明堂深凹盛水）");
  console.log("------------------------------------------------------------------");
  const palmTestInput = {
    textDescription:
      "右手掌丘整体红润厚实，掌心明堂明显深凹，手掌平摊可盛水；大拇指基底金星丘饱满高耸；生命线深长，内侧有一条清晰的平行火星贵人线；智慧线与生命线在起点完全分开呈川字掌，线条平直延伸至小指下方第二火星丘，末端有微小二分叉；感情线延伸至食指与中指指缝之间，上侧有细小羽毛纹。",
    notes: "性格独立果敢，平时决策果断，想了解近期事业财运与婚姻健康发展。",
  };

  try {
    const palmAnalysis = await analyzePalm(session, palmTestInput);
    console.log("\n【大宗师手相精析】：\n", palmAnalysis);
  } catch (err: any) {
    console.log(`(注：若未配置可用 AI_API_KEY，此处展示 API 调用报错说明: ${err.message})`);
  }

  console.log("\n[演示示例 3]：【面手双图综合合参】（测试面相与手相的互补与流年双轨交叉印证）");
  console.log("------------------------------------------------------------------");
  const combinedTestInput = {
    textDescription:
      "面相：天庭高广，目藏精光，山根41岁处略见浅细横纹，准头丰隆，仰月口；手相：右手川字掌，生命线41岁位置有方块保护纹包围，掌心明堂凹陷如盆积水不漏，智慧线尾端带作家商业二分叉。",
    notes: "当事人关注40岁左右的重大事业转型机运，以及面手互补化解之策。",
  };

  try {
    const combinedAnalysis = await analyzeCombined(session, combinedTestInput);
    console.log("\n【大宗师面手合参精析】：\n", combinedAnalysis);
  } catch (err: any) {
    console.log(`(注：若未配置可用 AI_API_KEY，此处展示 API 调用报错说明: ${err.message})`);
  }

  console.log("\n==================================================================");
  console.log(" 💡 运行完成！可通过传入真实图片调用：");
  console.log("    1. 面手双图合参 (推荐):");
  console.log("       node --experimental-strip-types examples/palm-face-reading/index.ts --face ./face.jpg --palm ./palm.jpg");
  console.log("    2. 单独面相分析:");
  console.log("       node --experimental-strip-types examples/palm-face-reading/index.ts --face ./face.jpg");
  console.log("    3. 单相手相分析:");
  console.log("       node --experimental-strip-types examples/palm-face-reading/index.ts --palm ./palm.jpg");
  console.log("==================================================================");
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  main().catch(console.error);
}
