import type { ProviderChunkResponse, Usage } from "../types/provider.js";

export interface SessionStreamFinalResult {
  content: string;
  reasoning?: string;
  usage?: Usage;
}

/**
 * SessionStream wraps a provider's chunk stream and provides rich developer ergonomics:
 * - AsyncIterable for `for await (const chunk of stream)`
 * - Promise helpers: `.text()`, `.reasoning()`, `.finalResult()`
 * - Callbacks: `.onText()`, `.onReasoning()`, `.onFinish()`
 * - Response piping: `.toReadableStream()`, `.pipeToResponse()`
 */
export class SessionStream implements AsyncIterable<ProviderChunkResponse> {
  private readonly source: AsyncIterable<ProviderChunkResponse>;
  private textBuffer = "";
  private reasoningBuffer = "";
  private finalUsage?: Usage;
  private isConsumed = false;
  private readonly textListeners: Array<(delta: string) => void> = [];
  private readonly reasoningListeners: Array<(reasoning: string) => void> = [];
  private readonly finishListeners: Array<(result: SessionStreamFinalResult) => void> = [];

  private completionPromise: Promise<SessionStreamFinalResult>;
  private resolveCompletion!: (res: SessionStreamFinalResult) => void;
  private rejectCompletion!: (err: unknown) => void;

  constructor(source: AsyncIterable<ProviderChunkResponse>) {
    this.source = source;
    this.completionPromise = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  /**
   * Listen for text content deltas.
   */
  onText(listener: (delta: string) => void): this {
    this.textListeners.push(listener);
    return this;
  }

  /**
   * Listen for reasoning / thinking deltas (e.g. DeepSeek-R1 / thinking models).
   */
  onReasoning(listener: (reasoning: string) => void): this {
    this.reasoningListeners.push(listener);
    return this;
  }

  /**
   * Listen for stream completion with final assembled content, reasoning, and usage.
   */
  onFinish(listener: (result: SessionStreamFinalResult) => void): this {
    this.finishListeners.push(listener);
    return this;
  }

  /**
   * Standard AsyncIterable implementation. Allows iterating chunks while triggering listeners.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<ProviderChunkResponse> {
    if (this.isConsumed) {
      throw new Error("SessionStream has already been consumed");
    }
    this.isConsumed = true;

    try {
      for await (const chunk of this.source) {
        if (chunk.reasoning) {
          this.reasoningBuffer += chunk.reasoning;
          for (const listener of this.reasoningListeners) {
            listener(chunk.reasoning);
          }
        }

        if (chunk.delta) {
          this.textBuffer += chunk.delta;
          for (const listener of this.textListeners) {
            listener(chunk.delta);
          }
        }

        if (chunk.usage) {
          this.finalUsage = chunk.usage;
        }

        yield chunk;
      }

      const result: SessionStreamFinalResult = {
        content: this.textBuffer,
        reasoning: this.reasoningBuffer.length > 0 ? this.reasoningBuffer : undefined,
        usage: this.finalUsage,
      };

      for (const listener of this.finishListeners) {
        listener(result);
      }
      this.resolveCompletion(result);
    } catch (err) {
      this.rejectCompletion(err);
      throw err;
    }
  }

  private async consumeIfNeeded(): Promise<SessionStreamFinalResult> {
    if (!this.isConsumed) {
      // Background consume the iterator if not manually iterated
      for await (const _ of this) {
        // consumed by [Symbol.asyncIterator]
      }
    }
    return this.completionPromise;
  }

  /**
   * Await the complete assembled text from the assistant.
   */
  async text(): Promise<string> {
    const result = await this.consumeIfNeeded();
    return result.content;
  }

  /**
   * Await the complete assembled reasoning / thinking process (DeepSeek-R1, etc).
   */
  async reasoning(): Promise<string> {
    const result = await this.consumeIfNeeded();
    return result.reasoning ?? "";
  }

  /**
   * Await the final assembled result with content, reasoning, and usage.
   */
  async finalResult(): Promise<SessionStreamFinalResult> {
    return this.consumeIfNeeded();
  }

  /**
   * Convert the stream to a Web standard ReadableStream<Uint8Array>.
   * Format can be 'text' (raw UTF-8 content) or 'sse' (Server-Sent Events: `data: ...\n\n`).
   */
  toReadableStream(format: "text" | "sse" = "text"): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = this[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            if (format === "sse") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            controller.close();
            return;
          }

          if (format === "text") {
            if (value.delta) {
              controller.enqueue(encoder.encode(value.delta));
            }
          } else if (format === "sse") {
            const payload = JSON.stringify({
              delta: value.delta,
              reasoning: value.reasoning,
              done: value.done,
              usage: value.usage,
            });
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  /**
   * Pipe this stream directly to an Express, Fastify, or standard Node.js HTTP ServerResponse.
   */
  async pipeToResponse(res: any, options: { format?: "text" | "sse" } = {}): Promise<void> {
    const format = options.format ?? "text";
    if (typeof res.setHeader === "function" && !res.headersSent) {
      if (format === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
      } else {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    }

    try {
      for await (const chunk of this) {
        if (format === "text") {
          if (chunk.delta) {
            res.write(chunk.delta);
          }
        } else if (format === "sse") {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
      if (format === "sse") {
        res.write("data: [DONE]\n\n");
      }
    } finally {
      if (typeof res.end === "function") {
        res.end();
      }
    }
  }
}
