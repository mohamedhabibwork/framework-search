// Public API of @framework/search.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (engines, indexer, manager, provider) stay in their modules.
export type { SearchConfig, SearchIndexDeclaration } from './config-schema';
export { defaultSearchConfig, searchConfigSchema, searchIndexDeclarationSchema } from './config-schema';
export { DEFAULT_SEARCH_LIMIT, SEARCH_ENGINE, SEARCH_INDEX_JOB, SEARCH_MANAGER, SOFT_DELETE_FIELD } from './constants';
export type { CapabilityReporter, SearchCapability } from './engine';
export {
  assertQuerySupported,
  flattenFields,
  isSoftDeleted,
  requireCapability,
  tokenize,
  withoutSoftDelete,
} from './engine';
export { MemorySearchEngine } from './engines/memory';
export type { PostgresSearchEngineOptions } from './engines/postgres';
export { PostgresSearchEngine } from './engines/postgres';
export type { SearchIndexConfig } from './index-definition';
export { defineSearchIndex, projectSearchDocument } from './index-definition';
export type { IndexerDependencies, IndexVerb, ReindexOptions, ReindexResult } from './indexer';
export { Indexer, reindexIndex } from './indexer';
export type { IndexDispatcher, IndexJobWirePayload } from './jobs';
export {
  applyIndexJob,
  defineIndexJob,
  indexJobPayloadSchema,
  inlineIndexDispatcher,
  queuedIndexDispatcher,
} from './jobs';
export type { SearchEngineFactory, SearchManagerOptions } from './manager';
export { createSearchManager, DefaultSearchManager } from './manager';
export { createSearchProvider } from './provider';
export type { SearchableOptions } from './searchable';
export { Searchable } from './searchable';
// Grouped conventions: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values stay in their modules.
export type {
  IndexerOptions,
  IndexJobOperation,
  IndexJobPayload,
  IndexJobResult,
  SearchCapabilities,
  SearchDocument,
  SearchEngine,
  SearchHit,
  SearchIndex,
  SearchManager,
  SearchQuery,
  SearchResult,
} from './types';
