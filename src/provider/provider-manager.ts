import type { IProvider } from "./provider.js";
import type { ProviderConfig } from "../types/provider.js";
import { InvalidRequestError } from "../types/errors.js";

export type ProviderFactory = (config: ProviderConfig) => IProvider;

/**
 * ProviderManager manages provider registration and creation by protocol.
 */
export class ProviderManager {
  private static factories = new Map<string, ProviderFactory>();

  /**
   * Register a provider factory for a specific protocol (e.g. 'openai', 'anthropic', 'gemini').
   */
  static registerProvider(protocol: string, factory: ProviderFactory): void {
    if (!protocol) {
      throw new InvalidRequestError("Protocol cannot be empty");
    }
    this.factories.set(protocol.toLowerCase(), factory);
  }

  /**
   * Check if a protocol has a registered factory.
   */
  static hasProvider(protocol: string): boolean {
    if (!protocol) return false;
    return this.factories.has(protocol.toLowerCase());
  }

  /**
   * Create a provider instance for the given configuration.
   */
  static createProvider(config: ProviderConfig): IProvider {
    if (!config || !config.protocol) {
      throw new InvalidRequestError("ProviderConfig must include a valid protocol");
    }
    const factory = this.factories.get(config.protocol.toLowerCase());
    if (!factory) {
      const registered = Array.from(this.factories.keys()).join(", ");
      throw new InvalidRequestError(
        `Unsupported provider protocol "${config.protocol}". Registered protocols: ${registered || "none"}`
      );
    }
    return factory(config);
  }

  /**
   * Clear all registered provider factories (useful for test resets).
   */
  static clear(): void {
    this.factories.clear();
  }
}
