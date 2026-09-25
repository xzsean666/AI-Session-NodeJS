# 🔮 东方相学大宗师：面相与手相智能分析系统 (RAG Knowledge Base)

基于 **AI-Session-NodeJS** SDK 构建的成熟中文相学 RAG（检索增强生成）系统。本系统将宋代《麻衣神相》、汉代《许负相法》等千年传统相学传世典籍与现代积极心理学融汇贯通，支持**传入真实照片（面相照、手相照）**或**文字特征**进行专业结构化深度分析。

---

## 🌟 核心特性

- 🏛️ **传世典籍知识库**：内置经严格考订的《麻衣神相》《许负相法》等古籍相法与五官掌纹体系，言必有据，辞必合典。
- 👁️ **全能多模态支持**：支持传入本地图片（`.jpg` / `.png` / `.webp` 自动转换为 Base64）、在线图片 URL 或文字特征描述。
- ⚡ **智能 RAG 动态检索 (省 95% Token)**：利用 SQLite FTS5 全文索引，根据用户提问与相貌特征按需召回相关章节，避免整库灌入爆 Token。
- 💾 **自动持久化与上下文压测**：结合 SQLite 会话持久化与滑动窗口/摘要压缩，支持多轮连续追问与长对话。
- 🌈 **积极正道心理引导**：秉持“形相为表，心术为里；相由心生，境随心转”之理念，不搞宿命迷信，重在知己知彼、趋吉避凶与修心改运。

---

## 📂 知识库架构（Knowledge Base Structure）

完整相学知识库位于 `knowledge/` 目录下，共包含三大核心模块 12 个专业文档：

```text
knowledge/
├── face/                   # 面相学：五官、三停与十二宫相法
│   ├── forehead.md         # 天庭与额相：上停（15-30岁）、日月角父母宫、司空、中正官禄宫、额纹与伏羲骨
│   ├── eyebrow.md          # 眉相与保寿官：兄弟宫、新月/柳叶/一字/剑眉、印堂命宫、田宅宫、31-34岁运
│   ├── eyes.md             # 眼相与监察官：心神枢纽、神藏与神露、丹凤眼/桃花眼/牛眼、三白四白、卧蚕男女宫
│   ├── nose.md             # 鼻相与审辨官：财帛宫中岳嵩山、山根疾厄、准头正财、兰台廷尉财库、41-50岁黄金运
│   └── mouth.md            # 口相与出纳官：下停晚运（51-70岁+）、仰月/四字口、人中寿堂、法令威仪、地阁下巴
│
├── palm/                   # 手相学：掌纹三大主线与九宫八卦
│   ├── lifeline.md         # 生命线（地纹）：体质元气、弧度开阔、岛纹障碍、双重贵人线、20-80岁流年黄金测算法
│   ├── headline.md         # 智慧线（人纹）：思维模式、同源稳健与川字掌、平直理性与下垂灵感、作家线与职业天赋
│   ├── heartline.md        # 感情线（天纹）：婚恋模式、深入木星丘与止于指缝、断掌（通贯手）特殊格局、人际情商
│   └── mounts.md           # 掌丘与后天八卦：木星丘/土星丘/太阳丘/水星丘/月丘/金星丘、掌心明堂凹陷聚财相法
│
└── books/                  # 传世古籍相术典藏与相法心法
    ├── mayishenxiang.md    # 《麻衣神相》：宋代麻衣道者授陈抟之相法鼻祖，十三部位总歌、面相十二宫精义与神骨论
    ├── xufuxiangfa.md      # 《许负相法》：汉代鸣雌亭侯许负相法，骨相篇、听声辨人篇、女人相法与心相改命心法
    └── mianshouhecan.md    # 《面手合参精要》：神相铁关刀与太清神鉴之形质互证，天圆地方/潜龙在渊/化煞为祥六大格局
```

---

## 🚀 快速启动指南

### 1. 配置环境变量

在项目根目录 `.env` 或当前终端中配置兼容 OpenAI / Gemini / Claude 视觉模型的 API 凭证：

```bash
# OpenAI 兼容格式（如 GPT-4o, Llama-3.2-Vision, Qwen-VL, GLM-4V 等）
export AI_PROVIDER_PROTOCOL=openai
export AI_BASE_URL="https://api.openai.com/v1"
export AI_API_KEY="sk-..."
export AI_MODEL="gpt-4o"

# 或使用 Google Gemini
# export AI_PROVIDER_PROTOCOL=gemini
# export AI_API_KEY="..."
# export AI_MODEL="gemini-1.5-flash"
```

### 2. 命令行传入图片进行分析 (CLI)

```bash
# 1. 【推荐】同时传入面部照片与手相照片，进行【面手双图综合合参】
node --experimental-strip-types examples/palm-face-reading/index.ts --face ./my-face.jpg --palm ./my-palm.png

# 2. 单独分析面相照片
node --experimental-strip-types examples/palm-face-reading/index.ts --face ./my-face.jpg

# 3. 单独分析手掌照片
node --experimental-strip-types examples/palm-face-reading/index.ts --palm ./my-palm.png

# 4. 运行内置全流程演示模式（包含典型相学案例与知识库检索）
node --experimental-strip-types examples/palm-face-reading/index.ts
```

---

## 💻 代码调用示例

### 示例 1：【面手双图合参】（同时传入面相与手相）

```typescript
import { createReadingSession, analyzeCombined } from "./index.ts";

async function run() {
  const { session } = createReadingSession();

  // 同时传入面相照片与手相照片，触发大宗师最高阶“面手合参”推演
  const result = await analyzeCombined(session, {
    faceImage: "./photos/face.jpg",
    palmImage: "./photos/palm.jpg",
    notes: "35岁男性，关注未来三年在科技创业与投资维度的机运与险阻。",
  });

  console.log(result);
}

run().catch(console.error);
```

### 示例 2：传入单张图片分析面相

```typescript
import { createReadingSession, analyzeFace } from "./index.ts";

async function run() {
  const { session } = createReadingSession();

  // 传入本地照片路径，SDK 会自动将其转化为多模态图片 Payload
  const result = await analyzeFace(session, {
    imagePathOrUrl: "./photos/avatar.jpg",
    notes: "当事人 32 岁，准备从传统行业转型科技管理岗位。",
  });

  console.log(result);
}

run().catch(console.error);
```

### 示例 3：传入手相特征文字或照片进行深度批断

```typescript
import { createReadingSession, analyzePalm } from "./index.ts";

async function run() {
  const { session } = createReadingSession();

  // 传入当事人手相特征（也可同时附带图片）
  const result = await analyzePalm(session, {
    imagePathOrUrl: "./photos/right_palm.jpg", // 可选图片
    textDescription: `
      右手川字掌，生命线深长，内侧有清晰火星贵人线；
      智慧线平直延伸至第二火星丘，末端有清晰二分叉；
      掌心明堂凹陷明显，手掌平展可盛水；
      感情线止于食指与中指之间。
    `,
    notes: "想了解近 3-5 年的事业合伙与财运发展。",
  });

  console.log(result);
}

run().catch(console.error);
```

---

## 📋 大宗师标准相术五步法解析流程

每次调用时，AI 宗师都会在 RAG 知识库支撑下按标准化流程推演：

1. **👁️ 象数特征提取**：
   - 面相：解构三停比例、额头天庭、眉眼清浊、鼻相财帛、口唇人中地阁。
   - 手相：提取掌型厚薄、九大掌丘高低、三才主线（生命线、智慧线、感情线）走势与特殊纹记。
2. **📜 古籍相诀印证**：
   - 自动从 `knowledge/` 检索并召回《麻衣神相》《许负相法》中的原典歌诀与断语进行印证。
3. **🔍 四大维度全景剖析**：
   - 🧠 **性格底色与心智模式**（逻辑 vs 直觉、决断魄力、情绪韧性）。
   - 💼 **事业发展与财运格局**（正偏财运、守财能力、适合的行业赛道）。
   - ❤️ **情感婚恋与人际气象**（恋爱观、伴侣相处模式、手足贵人缘）。
   - 🌿 **精力元气与健康关照**（体质底蕴、脏腑气血平衡与作息建议）。
4. **⏳ 流年运势与关键转折点**：
   - 结合面相百岁流年图或手相黄金流年测算法，定位当前大运与未来转折契机。
5. **🌟 宗师寄语与修心改运指引**：
   - 传授相圣许负心相心法：“有心无相，相随心生；有相无心，相随心灭”，提供积极的心态调适、习惯改善与积德行善之策。
