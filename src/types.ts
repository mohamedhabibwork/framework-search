/**
 * Every interface and type of `@framework/search` (the Scout equivalent).
 * Type-only: importing from this module never emits runtime code.
 *
 * The package is **driver-based**: a `SearchManager` resolves the configured
 * `SearchEngine`, each engine reports its capabilities honestly (ADR-11), and
 * indexing reuses the existing `@framework/events` + `@framework/queue` seams.
 */
import type { JsonObject } from '@framework/core';
import type { CrudTable, Page, PageRequest, SelectOf } from '@framework/database';

/** Honest capability report for a search backend (ADR-11). */
export interface SearchCapabilities {
  readonly fullText: boolean;
  readonly filters: boolean;
  readonly typoTolerance: boolean;
  readonly facets: boolean;
}

/** A document as stored in the index; always JSON-serialisable. */
export interface SearchDocument {
  readonly id: string;
  readonly fields: JsonObject;
}

export interface SearchQuery {
  readonly term?: string;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly limit?: number;
}

export interface SearchHit {
  readonly id: string;
  /** Relevance score, or `null` when the backend does not rank (e.g. filters only). */
  readonly score: number | null;
  readonly document: SearchDocument;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly capabilities: SearchCapabilities;
}

/** Driver-based search backend (memory, postgres, optional meilisearch/typesense). */
export interface SearchEngine {
  readonly name: string;
  readonly capabilities: SearchCapabilities;
  upsert(index: string, documents: readonly SearchDocument[]): Promise<void>;
  remove(index: string, ids: readonly string[]): Promise<void>;
  flush(index: string): Promise<void>;
  search(index: string, query: SearchQuery): Promise<SearchResult>;
  paginate(index: string, query: SearchQuery, page: PageRequest): Promise<Page<SearchHit>>;
}

/** Declares what a model exposes to search. Built by `defineSearchIndex`. */
export interface SearchIndex<TTable extends CrudTable> {
  readonly name: string;
  readonly source: TTable;
  readonly searchable: readonly string[];
  readonly filterable: readonly string[];
  readonly softDelete: boolean;
  project(row: SelectOf<TTable>): SearchDocument;
}

/** Options for `Indexer.register` (queued by default; `inline` for dev/tests). */
export interface IndexerOptions {
  readonly queue?: string;
  readonly inline?: boolean;
}

/** The two index writes: add/replace documents, or remove them by id. */
export type IndexJobOperation = 'upsert' | 'remove';

/**
 * Domain payload of one index write (what the `Indexer` produces and what
 * `applyIndexJob` consumes). Both arrays are always present (one is empty). It
 * is **not** itself a `JsonObject` (`SearchDocument` is an interface with no
 * index signature); the queued transport uses the JSON-safe
 * `IndexJobWirePayload` projection of it instead.
 */
export type IndexJobPayload = {
  readonly index: string;
  readonly operation: IndexJobOperation;
  readonly documents: readonly SearchDocument[];
  readonly ids: readonly string[];
};

/** Result of applying one index write. */
export type IndexJobResult = {
  readonly index: string;
  readonly operation: IndexJobOperation;
  readonly count: number;
};

/** Driver registry: resolves the engine bound to `search.driver`. */
export interface SearchManager {
  /** The engine selected by config, or the named driver. */
  engine(name?: string): SearchEngine;
  /** Names of every registered driver. */
  drivers(): readonly string[];
}
