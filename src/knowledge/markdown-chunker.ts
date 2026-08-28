import { defaultTokenEstimator } from "../context/token-estimator.js";

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

/**
 * Splits a markdown document into semantic sections based on Markdown Headings (#, ##, ###).
 * Preserves hierarchical breadcrumbs for context.
 */
export function chunkMarkdown(
  filePath: string,
  content: string,
  tokenEstimator = defaultTokenEstimator
): MarkdownSection[] {
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
      const tokens = tokenEstimator(`${headingTitle}\n${text}`);
      sections.push({
        heading: headingTitle,
        level: currentLevel,
        breadcrumbs,
        content: text,
        tokens,
      });
    }
    currentLines = [];
  };

  const headingRegex = /^(#{1,6})\s+(.+)$/;

  for (const line of lines) {
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
    } else {
      currentLines.push(line);
    }
  }

  flush();

  // If no sections were extracted (e.g. no headings), create single overview section
  if (sections.length === 0 && cleaned.length > 0) {
    const tokens = tokenEstimator(`${filePath}\n${cleaned}`);
    sections.push({
      heading: filePath,
      level: 1,
      breadcrumbs: [filePath],
      content: cleaned,
      tokens,
    });
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

  for (const line of lines) {
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

  return {
    filePath,
    title,
    headings,
  };
}
