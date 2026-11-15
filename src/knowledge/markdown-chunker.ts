import { defaultTokenEstimator, type TokenEstimatorFn } from "../context/token-estimator.js";

export interface MarkdownSection {
  heading: string;
  level: number;
  breadcrumbs: string[];
  content: string;
  tokens: number;
}

export interface DocumentTOC {
  filePath: string;
  title: string;
  headings: Array<{ heading: string; level: number }>;
}

/**
 * Clean up markdown noise: remove binary images, HTML comments, and extra whitespace.
 */
export function cleanMarkdown(content: string): string {
  return content
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Remove embedded image links ![]() but keep alt text if useful
    .replace(/!\[(.*?)\]\([^)]*\)/g, "$1")
    // Remove consecutive empty lines (more than 2)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface MarkdownChunkOptions {
  tokenEstimator?: TokenEstimatorFn;
  /**
   * Maximum tokens allowed per section chunk. Defaults to 800.
   * If a section's text exceeds this limit, it is cleanly split by paragraphs into sub-chunks.
   */
  maxSectionTokens?: number;
  /**
   * Number of overlap tokens to carry over from the end of the previous chunk when sub-chunking.
   * Defaults to 60.
   */
  overlapTokens?: number;
}

/**
 * Splits a markdown document into semantic sections based on Markdown Headings (#, ##, ###).
 * Preserves hierarchical breadcrumbs for context. Automatically splits oversized chapters into
 * paragraph-aligned sub-chunks with overlap.
 */
export function chunkMarkdown(
  filePath: string,
  content: string,
  optionsOrEstimator: TokenEstimatorFn | MarkdownChunkOptions = defaultTokenEstimator
): MarkdownSection[] {
  const tokenEstimator =
    typeof optionsOrEstimator === "function"
      ? optionsOrEstimator
      : optionsOrEstimator.tokenEstimator ?? defaultTokenEstimator;
  const maxSectionTokens =
    typeof optionsOrEstimator === "object" && optionsOrEstimator.maxSectionTokens !== undefined
      ? optionsOrEstimator.maxSectionTokens
      : 800;
  const overlapTokens =
    typeof optionsOrEstimator === "object" && optionsOrEstimator.overlapTokens !== undefined
      ? optionsOrEstimator.overlapTokens
      : 60;

  const cleaned = cleanMarkdown(content);
  const lines = cleaned.split("\n");
  const sections: MarkdownSection[] = [];

  const headingStack: Array<{ heading: string; level: number }> = [];
  let currentHeading = "Overview";
  let currentLevel = 1;
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      const breadcrumbs = [filePath, ...headingStack.map((h) => h.heading)];
      const headingTitle = breadcrumbs.join(" > ");
      const rawTokens = tokenEstimator(`${headingTitle}\n${text}`);

      if (rawTokens <= maxSectionTokens) {
        sections.push({
          heading: headingTitle,
          level: currentLevel,
          breadcrumbs,
          content: text,
          tokens: rawTokens,
        });
      } else {
        // Sub-chunk oversized section by paragraphs
        const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        const subChunks: string[] = [];
        let currentSubParagraphs: string[] = [];
        let currentTokens = 0;

        for (const p of paragraphs) {
          const pTokens = tokenEstimator(p);
          if (currentTokens + pTokens > maxSectionTokens && currentSubParagraphs.length > 0) {
            subChunks.push(currentSubParagraphs.join("\n\n"));
            // Keep overlap if configured
            if (overlapTokens > 0 && currentSubParagraphs.length > 0) {
              const lastP = currentSubParagraphs[currentSubParagraphs.length - 1];
              if (tokenEstimator(lastP) <= overlapTokens) {
                currentSubParagraphs = [lastP, p];
                currentTokens = tokenEstimator(lastP) + pTokens;
                continue;
              }
            }
            currentSubParagraphs = [p];
            currentTokens = pTokens;
          } else {
            currentSubParagraphs.push(p);
            currentTokens += pTokens;
          }
        }

        if (currentSubParagraphs.length > 0) {
          subChunks.push(currentSubParagraphs.join("\n\n"));
        }

        const totalParts = subChunks.length;
        for (let idx = 0; idx < totalParts; idx++) {
          const partIndex = idx + 1;
          const subHeadingTitle = totalParts > 1 ? `${headingTitle} (Part ${partIndex}/${totalParts})` : headingTitle;
          const subContent = subChunks[idx];
          const subTokens = tokenEstimator(`${subHeadingTitle}\n${subContent}`);
          sections.push({
            heading: subHeadingTitle,
            level: currentLevel,
            breadcrumbs: [
              filePath,
              ...headingStack.map((h) => h.heading),
              ...(totalParts > 1 ? [`${currentHeading} (Part ${partIndex})`] : []),
            ],
            content: subContent,
            tokens: subTokens,
          });
        }
      }
    }
    currentLines = [];
  };

  const headingRegex = /^(#{1,6})\s+(.+)$/;
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    if (!inCodeBlock) {
      const match = line.match(headingRegex);
      if (match) {
        flush();
        const level = match[1].length;
        const headingText = match[2].trim();

        // Adjust heading hierarchy stack
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ heading: headingText, level });

        currentHeading = headingText;
        currentLevel = level;
        continue;
      }
    }
    currentLines.push(line);
  }

  flush();

  // If no sections were extracted (e.g. no headings), split into overview section(s)
  if (sections.length === 0 && cleaned.length > 0) {
    currentLines = lines;
    currentHeading = filePath.split("/").pop() || filePath;
    flush();
  }

  return sections;
}

/**
 * Generates a lightweight Table of Contents (TOC) for a markdown file.
 */
export function extractMarkdownTOC(filePath: string, content: string): DocumentTOC {
  const lines = content.split("\n");
  const headings: Array<{ heading: string; level: number }> = [];
  let title = filePath;

  const headingRegex = /^(#{1,4})\s+(.+)$/;
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!inCodeBlock) {
      const match = line.match(headingRegex);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();
        if (level === 1 && title === filePath) {
          title = text;
        }
        headings.push({ heading: text, level });
      }
    }
  }

  return {
    filePath,
    title,
    headings,
  };
}
