import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  KnowledgeManager,
  chunkMarkdown,
  extractMarkdownTOC,
  extractCodeSkeleton,
  SQLiteStorage,
} from "../../src/index.js";

describe("Knowledge Base & Chunker", () => {
  const tempDir = path.resolve("./test/scratch-knowledge");

  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("chunkMarkdown & extractMarkdownTOC", () => {
    it("chunks markdown by heading levels and creates breadcrumbs", () => {
      const md = `
# E-Commerce Architecture
Introduction text here. <!-- HTML comment to be stripped -->
![diagram](https://example.com/diag.png)

## Order Service
Handles order placement.

### Cancellation Rule
Only PENDING orders can be cancelled.

## Payment Service
Handles Stripe & PayPal integration.
`;

      const sections = chunkMarkdown("docs/architecture.md", md);
      expect(sections.length).toBeGreaterThanOrEqual(3);

      const cancelSection = sections.find((s) => s.heading.includes("Cancellation Rule"));
      expect(cancelSection).toBeDefined();
      expect(cancelSection?.breadcrumbs).toEqual([
        "docs/architecture.md",
        "E-Commerce Architecture",
        "Order Service",
        "Cancellation Rule",
      ]);
      expect(cancelSection?.content).toContain("Only PENDING orders can be cancelled.");

      // Check TOC
      const toc = extractMarkdownTOC("docs/architecture.md", md);
      expect(toc.title).toBe("E-Commerce Architecture");
      expect(toc.headings.map((h) => h.heading)).toContain("Order Service");
      expect(toc.headings.map((h) => h.heading)).toContain("Payment Service");
    });
  });

  describe("extractCodeSkeleton", () => {
    it("extracts TypeScript interfaces, types and exported function signatures without bodies", () => {
      const code = `
import { Database } from "sqlite";

export interface User {
  id: string;
  name: string;
}

export type UserRole = "admin" | "member";

/**
 * Calculates discount
 */
export function calculateDiscount(price: number, role: UserRole): number {
  const tax = 0.05;
  if (role === "admin") {
    return price * 0.8;
  }
  return price * 0.95;
}
`;

      const skeleton = extractCodeSkeleton("src/user.ts", code);
      expect(skeleton).toContain("export interface User");
      expect(skeleton).toContain("export type UserRole");
      expect(skeleton).toContain("calculateDiscount(price: number, role: UserRole): number");
      expect(skeleton).toContain("/* implementation omitted */");
      expect(skeleton).not.toContain("const tax = 0.05");
    });
  });

  describe("KnowledgeManager Incremental Sync", () => {
    it("indexes directory incrementally and updates only modified files", async () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });

      // Create initial files
      const doc1 = path.join(tempDir, "doc1.md");
      const doc2 = path.join(tempDir, "doc2.md");

      fs.writeFileSync(doc1, "# Document 1\n## Section 1\nContent of doc 1");
      fs.writeFileSync(doc2, "# Document 2\n## Section 2\nContent of doc 2");

      const manager = new KnowledgeManager(
        {
          path: tempDir,
          prompt: "You are an assistant with project knowledge.",
          mode: "rag",
          maxKnowledgeTokens: 1500,
        },
        storage
      );

      // 1. Initial Sync
      const result1 = await manager.sync();
      expect(result1.totalFiles).toBe(2);
      expect(result1.updatedFiles).toBe(2);
      expect(storage.chunkCount).toBeGreaterThanOrEqual(2);

      // 2. Second Sync with no changes -> zero files updated (instant cache hit!)
      const result2 = await manager.sync();
      expect(result2.totalFiles).toBe(2);
      expect(result2.updatedFiles).toBe(0);
      expect(result2.isIncremental).toBe(true);

      // 3. Modify 1 file
      // Small timeout to guarantee mtime change on fast filesystems
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(doc1, "# Document 1 Modified\n## Section 1 New\nUpdated content");

      const result3 = await manager.sync();
      expect(result3.totalFiles).toBe(2);
      expect(result3.updatedFiles).toBe(1);

      // 4. Delete 1 file
      fs.unlinkSync(doc2);
      const result4 = await manager.sync();
      expect(result4.totalFiles).toBe(1);
      expect(result4.deletedFiles).toBe(1);

      storage.close();
    });

    it("builds dynamic system context with TOC and query-matched chunks", async () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });

      const file = path.join(tempDir, "rules.md");
      fs.writeFileSync(
        file,
        `# Business Rules
## Rule 101 Stock Locking
Users must lock inventory for 15 minutes in Redis.

## Rule 102 Order Cancellation
Only orders in PENDING status can be cancelled.
`
      );

      const manager = new KnowledgeManager(
        {
          path: tempDir,
          prompt: "You are a senior architect.",
          mode: "rag",
          maxKnowledgeTokens: 1000,
        },
        storage
      );

      const { systemPrompt, injectedTokens } = await manager.buildSystemContext(
        "Can I cancel an order?"
      );

      expect(systemPrompt).toContain("You are a senior architect.");
      expect(injectedTokens).toBeGreaterThan(0);
      expect(injectedTokens).toBeLessThan(1000);

      storage.close();
    });

    it("supports in-memory content and virtual files for Cloudflare Workers without disk", async () => {
      // Direct string content
      const contentManager = new KnowledgeManager({
        content: `# Refund Manual\n## Window\nRefunds must be requested within 30 days.\n## Fees\nProcessing fee is $5.`,
        prompt: "You are a refund assistant.",
        mode: "rag",
      });

      const res1 = await contentManager.buildSystemContext("How many days for refund?");
      expect(res1.systemPrompt).toContain("You are a refund assistant.");
      expect(res1.systemPrompt).toContain("Refund Manual > Window");
      expect(res1.systemPrompt).toContain("Refunds must be requested within 30 days.");

      // Virtual file dictionary (e.g. bundled in Worker)
      const virtualFilesManager = new KnowledgeManager({
        files: {
          "docs/faq.md": "# FAQ\n## Shipping\nWorldwide express shipping takes 3 days.",
          "docs/api.md": "# API\n## Auth\nUse Bearer token in headers.",
        },
        prompt: "API Guide",
        mode: "rag",
      });

      const res2 = await virtualFilesManager.buildSystemContext("How does shipping work?");
      expect(res2.systemPrompt).toContain("FAQ > Shipping");
      expect(res2.systemPrompt).toContain("Worldwide express shipping takes 3 days.");
      expect(res2.systemPrompt).toContain("Knowledge Base Overview");
    });
  });
});
