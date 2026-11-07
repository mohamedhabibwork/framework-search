/** Constants of `@framework/search`: DI tokens and fixed defaults. */
import { token } from '@framework/core';
import type { SearchEngine, SearchManager } from './types';

/** The active search engine (driver selected by `search.driver`). */
export const SEARCH_ENGINE = token<SearchEngine>('search.engine');

/** The search manager (driver registry + engine access). */
export const SEARCH_MANAGER = token<SearchManager>('search.manager');

/**
 * Reserved document field marking a soft-deleted row. `defineSearchIndex` sets
 * it (from the source's soft-delete column) when `softDelete` is true; every
 * engine excludes such documents from `search`/`paginate` and never returns the
 * field. It lives here so drivers and index definitions agree on one key.
 */
export const SOFT_DELETE_FIELD = '__softDeleted';

/** Default result count for an unpaginated search when the query sets no `limit`. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Queue job name carrying one index write (upsert/remove) in queued mode. */
export const SEARCH_INDEX_JOB = 'search.index';
