import { describe, it, expect } from "vitest";
import {
  defaultTokenEstimator,
  estimateMessageTokens,
} from "../../src/index.js";

describe("Token Estimator (TASK-009)", () => {
  it("estimates 0 tokens for empty or null strings", () => {
    expect(defaultTokenEstimator("")).toBe(0);
    // @ts-expect-error test falsy
    expect(defaultTokenEstimator(null)).toBe(0);
  });

  it("estimates Latin/ASCII text at approximately 4 characters per token", () => {
    const text = "Hello world! This is a simple test sentence.";
    const count = defaultTokenEstimator(text);
    expect(count).toBe(Math.ceil(text.length / 4));
    expect(count).toBeGreaterThan(5);
  });

  it("estimates CJK characters at approximately 1 token per character", () => {
    const cjkText = "这是一个中文测试句子"; // 10 chars
    const count = defaultTokenEstimator(cjkText);
    expect(count).toBe(10);
  });

  it("handles mixed Latin and CJK text", () => {
    const mixed = "AI Session 中文测试"; // 11 non-cjk chars (Math.ceil(11/4)=3) + 4 cjk = 7
    const count = defaultTokenEstimator(mixed);
    expect(count).toBe(7);
  });

  it("estimates message tokens including framing overhead", () => {
    const msg = { role: "user", content: "Hello" };
    const tokens = estimateMessageTokens(msg);
    // content tokens (Math.ceil(5/4)=2) + role tokens (Math.ceil(4/4)=1) + 4 = 7
    expect(tokens).toBe(7);
  });
});
