/** Driver registry: resolves the `SearchEngine` bound to `search.driver`. */
import { ConfigError } from '@framework/core';
import type { SearchEngine, SearchManager } from './types';

/** Builds an engine on first use (so a driver's connection stays lazy). */
export type SearchEngineFactory = () => SearchEngine;

export interface SearchManagerOptions {
  /** The driver selected by `search.driver`. */
  readonly driver: string;
  /** Every registered driver, keyed by name (`memory`, `postgres`, …). */
  readonly engines: Readonly<Record<string, SearchEngineFactory>>;
}

/**
 * Default registry. Engines are built lazily and cached, so a driver that needs
 * a database connection never opens one until it is actually resolved.
 */
export class DefaultSearchManager implements SearchManager {
  readonly #driver: string;
  readonly #factories = new Map<string, SearchEngineFactory>();
  readonly #instances = new Map<string, SearchEngine>();

  constructor(options: SearchManagerOptions) {
    this.#driver = options.driver;
    for (const [name, factory] of Object.entries(options.engines)) this.#factories.set(name, factory);
    if (!this.#factories.has(this.#driver)) {
      throw new ConfigError([`search.driver: no engine registered for "${this.#driver}"`]);
    }
  }

  /** Adds or replaces a driver (used by apps registering an optional-peer backend). */
  register(name: string, factory: SearchEngineFactory): this {
    this.#factories.set(name, factory);
    this.#instances.delete(name);
    return this;
  }

  /** The configured driver, or the named one; unknown names are a configuration error. */
  engine(name?: string): SearchEngine {
    const key = name ?? this.#driver;
    const cached = this.#instances.get(key);
    if (cached) return cached;
    const factory = this.#factories.get(key);
    if (!factory) throw new ConfigError([`search: unknown engine "${key}"`]);
    const instance = factory();
    this.#instances.set(key, instance);
    return instance;
  }

  drivers(): readonly string[] {
    return [...this.#factories.keys()];
  }
}

export function createSearchManager(options: SearchManagerOptions): DefaultSearchManager {
  return new DefaultSearchManager(options);
}
