import { defaultTokenEstimator } from "../context/token-estimator.js";

function countBraces(str: string): number {
  let diff = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 123) diff++;
    else if (code === 125) diff--;
  }
  return diff;
}

/**
 * Extracts TypeScript / JavaScript definitions (interfaces, types, exported classes/functions)
 * and preserves class method/property signatures while removing implementation bodies to save up to 80% token space.
 */
export function extractCodeSkeleton(filePath: string, source: string): string {
  const ext = filePath.toLowerCase();
  const isTsOrJs =
    ext.endsWith(".ts") ||
    ext.endsWith(".tsx") ||
    ext.endsWith(".js") ||
    ext.endsWith(".mjs") ||
    ext.endsWith(".cjs");

  if (!isTsOrJs) {
    return source;
  }

  const lines = source.split("\n");
  const resultLines: string[] = [];
  let inDocComment = false;
  let braceDepth = 0;
  let capturingInterface = false;
  let capturingClass = false;
  let classBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Preserve JSDoc comments
    if (trimmed.startsWith("/**")) {
      inDocComment = true;
      resultLines.push(line);
      if (trimmed.endsWith("*/")) {
        inDocComment = false;
      }
      continue;
    }
    if (inDocComment) {
      resultLines.push(line);
      if (trimmed.endsWith("*/")) {
        inDocComment = false;
      }
      continue;
    }

    // 2. Preserve imports/exports/types/interfaces
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export type ") ||
      trimmed.startsWith("export interface ") ||
      trimmed.startsWith("type ") ||
      trimmed.startsWith("interface ")
    ) {
      resultLines.push(line);
      if (trimmed.includes("{") && !trimmed.includes("}")) {
        capturingInterface = true;
        braceDepth += countBraces(line);
      }
      continue;
    }

    if (capturingInterface) {
      resultLines.push(line);
      braceDepth += countBraces(line);
      if (braceDepth <= 0) {
        capturingInterface = false;
        braceDepth = 0;
      }
      continue;
    }

    // 3. Class definitions: preserve class header and method signatures, omit bodies
    if (
      trimmed.startsWith("export class ") ||
      trimmed.startsWith("export abstract class ") ||
      trimmed.startsWith("export default class ") ||
      (!capturingClass && trimmed.startsWith("class "))
    ) {
      if (trimmed.includes("{")) {
        capturingClass = true;
        classBraceDepth += countBraces(line);
        resultLines.push(line.split("{")[0].trimEnd() + " {");
      } else {
        resultLines.push(line);
      }
      continue;
    }

    if (capturingClass) {
      const netBraces = countBraces(line);
      classBraceDepth += netBraces;

      if (classBraceDepth <= 0) {
        capturingClass = false;
        classBraceDepth = 0;
        resultLines.push("}");
        continue;
      }

      // Check for class members (methods, properties, constructor)
      if (
        trimmed.startsWith("constructor") ||
        trimmed.startsWith("public ") ||
        trimmed.startsWith("private ") ||
        trimmed.startsWith("protected ") ||
        trimmed.startsWith("static ") ||
        trimmed.startsWith("async ") ||
        trimmed.startsWith("get ") ||
        trimmed.startsWith("set ") ||
        trimmed.startsWith("readonly ") ||
        /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/.test(trimmed)
      ) {
        if (trimmed.endsWith(";")) {
          resultLines.push(line);
        } else if (trimmed.includes("{")) {
          const sig = line.split("{")[0].trimEnd();
          resultLines.push(`${sig} { /* ... */ }`);
        } else {
          resultLines.push(line);
        }
      }
      continue;
    }

    // 4. Standalone exported functions or constants
    if (
      trimmed.startsWith("export function ") ||
      trimmed.startsWith("export async function ") ||
      trimmed.startsWith("export const ") ||
      trimmed.startsWith("export let ") ||
      trimmed.startsWith("export var ")
    ) {
      if (trimmed.endsWith(";")) {
        resultLines.push(line);
      } else if (trimmed.includes("{")) {
        const decl = line.split("{")[0].trimEnd();
        resultLines.push(`${decl} { /* implementation omitted */ }`);
      } else {
        resultLines.push(line);
      }
      continue;
    }
  }

  const skeleton = resultLines.join("\n").trim();
  return skeleton.length > 0 ? skeleton : source;
}
