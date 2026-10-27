/**
 * `Searchable` — the mixin that marks a repository's table as searchable and
 * yields its `SearchIndex` declaration. It declares *what* to search; the
 * `Indexer` wires *when* (events) and the engine decides *how*.
 */
import {
  assertNoCollision,
  type CrudTable,
  type RepositoryCore,
  type SelectOf,
  type TableOf,
} from '@framework/database';
import { defineSearchIndex } from './index-definition';
import type { SearchDocument, SearchIndex } from './types';

// TypeScript's mixin pattern requires a constructor accepting any arguments
// (mirrors @framework/database's own `RepositoryConstructor`).
// biome-ignore lint/suspicious/noExplicitAny: required mixin constructor signature
type RepositoryConstructor = abstract new (...args: any[]) => RepositoryCore<CrudTable>;

export interface SearchableOptions<TTable extends CrudTable> {
  /** Logical index name the engine is addressed by (e.g. `products`). */
  readonly name: string;
  /** Field names searched by full-text term matching. */
  readonly searchable?: readonly string[];
  /** Field names usable in `SearchQuery.filters`. */
  readonly filterable?: readonly string[];
  /** Exclude rows whose soft-delete column is set. */
  readonly softDelete?: boolean;
  /** Property name of the soft-delete column; defaults to `deletedAt`. */
  readonly softDeleteField?: string;
  /** Overrides the default projection. */
  readonly project?: (row: SelectOf<TTable>) => SearchDocument;
}

/**
 * Adds `searchIndex()` (the declarative index) and `searchableFields()` to a
 * repository. Combine it like the other mixins:
 * `Searchable(SoftDeletable(Creatable(Readable(RepositoryCore<typeof products>)))), { name: 'products', … })`.
 */
export function Searchable<TBase extends RepositoryConstructor>(
  Base: TBase,
  options: SearchableOptions<TableOf<TBase>>,
) {
  assertNoCollision(Base, 'Searchable', ['searchIndex', 'searchableFields']);

  abstract class SearchableRepository extends Base {
    /** The declarative index definition derived from this repository's table. */
    searchIndex(): SearchIndex<TableOf<TBase>> {
      // The table type argument is pinned explicitly: TypeScript cannot infer
      // it from `this.table` (the deferred `TableOf<TBase>` fails the
      // `CrudTable` constraint check, so inference would silently fall back to
      // the constraint and type `project` against `SelectOf<CrudTable>`).
      return defineSearchIndex<TableOf<TBase>>({
        name: options.name,
        source: this.table,
        searchable: options.searchable,
        filterable: options.filterable,
        softDelete: options.softDelete,
        softDeleteField: options.softDeleteField,
        project: options.project,
      });
    }

    /** Field names exposed to full-text search. */
    searchableFields(): readonly string[] {
      return options.searchable ?? [];
    }
  }
  return SearchableRepository;
}
