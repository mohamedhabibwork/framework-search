import { ConfigError, type JsonValue } from '@framework/core';
import { type CrudTable, type SelectOf, toJsonRow } from '@framework/database';
import { SOFT_DELETE_FIELD } from './constants';
import type { SearchDocument, SearchIndex } from './types';

/** Input to {@link defineSearchIndex}; `project` defaults to the searchable+filterable projection. */
export interface SearchIndexConfig<TTable extends CrudTable> {
  /** Logical index name the engine is addressed by (e.g. `products`). */
  readonly name: string;
  /** The table this index mirrors. */
  readonly source: TTable;
  /** Field names searched by full-text term matching. */
  readonly searchable?: readonly string[];
  /** Field names usable in `SearchQuery.filters`. */
  readonly filterable?: readonly string[];
  /** When true, rows whose soft-delete column is set are excluded from results. */
  readonly softDelete?: boolean;
  /** Property name of the soft-delete column; defaults to `deletedAt`. */
  readonly softDeleteField?: string;
  /** Maps a source row to the indexed document; overrides the default projection. */
  readonly project?: (row: SelectOf<TTable>) => SearchDocument;
}

const DEFAULT_SOFT_DELETE_FIELD = 'deletedAt';

/**
 * Builds the declarative description of what a model exposes to search. It is a
 * pure value: it validates the configuration, records the searchable/filterable
 * fields and, when `softDelete` is true, projects the source's soft-delete
 * column into the reserved {@link SOFT_DELETE_FIELD} marker every engine filters on.
 */
export function defineSearchIndex<TTable extends CrudTable>(config: SearchIndexConfig<TTable>): SearchIndex<TTable> {
  const issues: string[] = [];
  if (config.name.trim().length === 0) issues.push('name must be a non-empty string');

  const searchable = normalizeFields(config.searchable ?? [], 'searchable', issues);
  const filterable = normalizeFields(config.filterable ?? [], 'filterable', issues);
  const softDelete = config.softDelete ?? false;
  const softDeleteField = config.softDeleteField ?? DEFAULT_SOFT_DELETE_FIELD;
  if (softDelete && softDeleteField.trim().length === 0) {
    issues.push('softDeleteField must be a non-empty string when softDelete is true');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const projected = dedupe([...searchable, ...filterable]);
  const project =
    config.project ??
    ((row: SelectOf<TTable>): SearchDocument =>
      projectSearchDocument(row, projected, softDelete ? softDeleteField : undefined));

  return {
    name: config.name,
    source: config.source,
    searchable,
    filterable,
    softDelete,
    project,
  };
}

/**
 * Default projection: the union of searchable + filterable fields, plus the
 * soft-delete marker. Exported so the CLI's re-index path projects rows the
 * same way `defineSearchIndex` does.
 */
export function projectSearchDocument(
  row: object,
  fields: readonly string[],
  softDeleteField?: string,
): SearchDocument {
  const snapshot = toJsonRow(row);
  const projected: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = snapshot[field];
    if (value !== undefined) projected[field] = value;
  }
  if (softDeleteField !== undefined) {
    const deleted = snapshot[softDeleteField];
    if (deleted !== undefined && deleted !== null) projected[SOFT_DELETE_FIELD] = true;
  }
  const id = snapshot.id;
  return { id: typeof id === 'string' ? id : String(id ?? ''), fields: projected };
}

function normalizeFields(fields: readonly string[], label: string, issues: string[]): readonly string[] {
  const normalized: string[] = [];
  for (const field of fields) {
    if (field.trim().length === 0) {
      issues.push(`${label} entries must be non-empty strings`);
      continue;
    }
    normalized.push(field);
  }
  return dedupe(normalized);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
