import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeManager } from "../../dist/index.mjs";
import { SQLiteStorage } from "../../dist/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function verify() {
  const knowledgePath = path.resolve(__dirname, "knowledge");
  const storage = new SQLiteStorage({ dbPath: ":memory:" });
  const km = new KnowledgeManager(
    {
      path: knowledgePath,
      mode: "rag",
      maxKnowledgeTokens: 2000,
      searchLimit: 6,
    },
    storage
  );

  console.log("=== [1] 同步并构建知识库 ===");
  const syncRes = await km.sync();
  console.log(`文件总数: ${syncRes.totalFiles}, 切片总数: ${syncRes.totalChunks}`);

  console.log("\n=== [2] 模拟面相查询: '天庭高广 悬胆鼻 仰月口 麻衣神相' ===");
  const faceCtx = await km.buildSystemContext("天庭高广 悬胆鼻 仰月口 麻衣神相");
  console.log(`注入 Tokens 预估: ${faceCtx.injectedTokens}`);
  console.log("检索到的知识前 500 字符预览:\n", faceCtx.systemPrompt.slice(0, 800));

  console.log("\n=== [3] 模拟手相查询: '川字掌 火星贵人线 生命线 许负' ===");
  const palmCtx = await km.buildSystemContext("川字掌 火星贵人线 生命线 许负");
  console.log(`注入 Tokens 预估: ${palmCtx.injectedTokens}`);
  console.log("检索到的知识前 500 字符预览:\n", palmCtx.systemPrompt.slice(0, 800));
}

verify().catch(console.error);
