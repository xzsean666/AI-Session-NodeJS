import {
  AuthenticationError,
  RateLimitError,
  ProviderError,
} from "../types/errors.js";

/**
 * Parses HTTP error response from provider API and throws the corresponding typed error.
 */
export async function handleProviderHttpError(
  response: Response,
  protocol: string
): Promise<never> {
  let errorData: unknown;
  let errorMessage = `Provider "${protocol}" request failed with status ${response.status} ${response.statusText}`;

  try {
    const text = await response.text();
    if (text) {
      try {
        errorData = JSON.parse(text);
        if (typeof errorData === "object" && errorData !== null) {
          const errObj = errorData as Record<string, unknown>;
          if (typeof errObj.message === "string") {
            errorMessage = errObj.message;
          } else if (typeof errObj.error === "object" && errObj.error !== null) {
            const nested = errObj.error as Record<string, unknown>;
            if (typeof nested.message === "string") {
              errorMessage = nested.message;
            }
          }
        }
      } catch {
        errorData = text;
        errorMessage = `${errorMessage}: ${text}`;
      }
    }
  } catch {
    // ignore read error
  }

  const options = {
    statusCode: response.status,
    protocol,
    rawError: errorData,
  };

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(errorMessage, options);
  }

  if (response.status === 429) {
    throw new RateLimitError(errorMessage, options);
  }

  throw new ProviderError(errorMessage, options);
}

/**
 * Resilient fetch wrapper with automatic retry on transient errors (429 rate limit, 503 overload).
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  options: RequestInit,
  maxRetries: number = 2,
  baseDelayMs: number = 1500
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    const response = await fetchFn(url, options);
    if (
      attempt <= maxRetries &&
      (response.status === 429 ||
        response.status === 503 ||
        response.status === 502 ||
        response.status === 504)
    ) {
      const delay = attempt * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    return response;
  }
}

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Async generator that reads an SSE ReadableStream and yields parsed SSEEvents.
 * Uses index-based newline slicing to avoid high-frequency regex allocations.
 */
export async function* iterateSSEEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let currentEvent: Partial<SSEEvent> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        if (line.trim() === "") {
          if (currentEvent.data !== undefined) {
            yield {
              data: currentEvent.data,
              event: currentEvent.event,
              id: currentEvent.id,
            };
            currentEvent = {};
          }
          continue;
        }

        if (line.startsWith(":")) {
          // Comment line, ignore
          continue;
        }

        const colonIndex = line.indexOf(":");
        let field: string;
        let val: string;

        if (colonIndex === -1) {
          field = line;
          val = "";
        } else {
          field = line.slice(0, colonIndex);
          val = line.slice(colonIndex + 1);
          if (val.startsWith(" ")) {
            val = val.slice(1);
          }
        }

        if (field === "data") {
          currentEvent.data = currentEvent.data !== undefined ? `${currentEvent.data}\n${val}` : val;
        } else if (field === "event") {
          currentEvent.event = val;
        } else if (field === "id") {
          currentEvent.id = val;
        }
      }
    }

    // Flush any remaining buffer if it ends with data
    if (buffer.trim().length > 0) {
      if (buffer.startsWith("data:")) {
        const val = buffer.slice(5).trim();
        yield { data: val };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
