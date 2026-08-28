export class AISessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StorageError extends AISessionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class SessionNotFoundError extends AISessionError {
  public readonly userId: string;
  public readonly sessionId: string;

  constructor(userId: string, sessionId: string, options?: ErrorOptions) {
    super(`Session not found for user "${userId}" and sessionId "${sessionId}"`, options);
    this.name = "SessionNotFoundError";
    this.userId = userId;
    this.sessionId = sessionId;
  }
}

export class ProviderError extends AISessionError {
  public readonly statusCode?: number;
  public readonly protocol?: string;
  public readonly rawError?: unknown;

  constructor(
    message: string,
    options?: {
      statusCode?: number;
      protocol?: string;
      rawError?: unknown;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "ProviderError";
    this.statusCode = options?.statusCode;
    this.protocol = options?.protocol;
    this.rawError = options?.rawError;
  }
}

export class AuthenticationError extends ProviderError {
  constructor(
    message: string,
    options?: {
      statusCode?: number;
      protocol?: string;
      rawError?: unknown;
      cause?: unknown;
    }
  ) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    options?: {
      statusCode?: number;
      protocol?: string;
      rawError?: unknown;
      cause?: unknown;
    }
  ) {
    super(message, options);
    this.name = "RateLimitError";
  }
}

export class InvalidRequestError extends AISessionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidRequestError";
  }
}

export class CompactError extends AISessionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactError";
  }
}
