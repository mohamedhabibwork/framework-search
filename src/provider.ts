/**
 * `createSearchProvider` — binds the search stack from the `search` config
 * section: `SEARCH_ENGINE` (the configured driver) and `SEARCH_MANAGER` (the
 * driver registry). Engines are built lazily, so the Postgres driver resolves
 * the shared `DATABASE` connection only when it is first used.
 */
import { ConfigError, defineProvider, type ServiceProvider } from '@framework/core';
import { DATABASE } from '@framework/database';
import { type SearchConfig, searchConfigSchema } from './config-schema';
import { SEARCH_ENGINE, SEARCH_MANAGER } from './constants';
import { MemorySearchEngine } from './engines/memory';
import { PostgresSearchEngine } from './engines/postgres';
import { DefaultSearchManager, type SearchEngineFactory } from './manager';

/**
 * Registers `SEARCH_ENGINE` + `SEARCH_MANAGER` as singletons. Applications add
 * it to their provider list and compose `search: searchConfigSchema.default({})`
 * into their config schema.
 */
export function createSearchProvider<TConfig extends { readonly search: SearchConfig }>(): ServiceProvider<TConfig> {
  return defineProvider<TConfig>({
    name: 'search',
    register({ container, config }) {
      const parsed = searchConfigSchema.safeParse(config.search);
      if (!parsed.success) {
        throw new ConfigError(parsed.error.issues.map((issue) => `search.${issue.path.join('.')}: ${issue.message}`));
      }
      const settings = parsed.data;

      const engines: Record<string, SearchEngineFactory> = {
        memory: () => new MemorySearchEngine(),
      };
      if (settings.driver === 'postgres') {
        engines.postgres = () =>
          new PostgresSearchEngine(container.resolve(DATABASE), {
            prefix: settings.prefix,
            language: settings.language,
          });
      }

      const manager = new DefaultSearchManager({ driver: settings.driver, engines });
      container.singleton(SEARCH_MANAGER, () => manager);
      container.singleton(SEARCH_ENGINE, () => manager.engine());
    },
  });
}
