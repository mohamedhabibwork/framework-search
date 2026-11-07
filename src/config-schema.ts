import { z } from 'zod/v4';

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * One index declaration as the CLI sees it: the source table plus the fields
 * to project. `defineSearchIndex` is the runtime view of the same thing; this
 * is the storage/config view used by `search:index`/`search:flush`/`search:status`.
 */
export const searchIndexDeclarationSchema = z.object({
  /** Logical index name (the engine is addressed by it). */
  name: z.string().regex(IDENTIFIER, 'index name must be a lowercase identifier'),
  /** Source table the index mirrors. */
  source: z.string().regex(IDENTIFIER, 'source must be a table name'),
  searchable: z.array(z.string().min(1)).default([]),
  filterable: z.array(z.string().min(1)).default([]),
  softDelete: z.boolean().default(false),
  softDeleteField: z.string().min(1).default('deletedAt'),
});

export type SearchIndexDeclaration = z.output<typeof searchIndexDeclarationSchema>;

/**
 * Validated shape of the application's `search` configuration section. Apps
 * compose it into their config schema: `search: searchConfigSchema.default({})`.
 *
 * `driver` selects the `SearchEngine` the manager resolves; the remaining keys
 * are the storage/indexing knobs the drivers read.
 */
export const searchConfigSchema = z.object({
  /** Active driver: `memory` (dev/tests) or `postgres` (tsvector + GIN). */
  driver: z.enum(['memory', 'postgres']).default('memory'),
  /** How writes are propagated to the index: queued by default, inline for dev/tests. */
  indexing: z.enum(['queued', 'inline']).default('queued'),
  /** Physical table prefix used by the postgres driver (one table per index). */
  prefix: z
    .string()
    .regex(/^[a-z0-9_]*$/u, 'prefix must be a simple identifier (a-z, 0-9, _)')
    .default('search_'),
  /** Text-search configuration (`regconfig`) used by the postgres driver. */
  language: z
    .string()
    .regex(/^[a-z_]+$/u, 'language must be a lowercase regconfig name')
    .default('english'),
  /** Indexes the CLI can import/flush/inspect (the storage view of `defineSearchIndex`). */
  indexes: z.array(searchIndexDeclarationSchema).default([]),
});

export type SearchConfig = z.output<typeof searchConfigSchema>;

/** Resolved defaults, exported for tests and documentation. */
export const defaultSearchConfig: SearchConfig = searchConfigSchema.parse({});
