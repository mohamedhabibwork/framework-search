/**
 * Event-driven indexing and full re-index.
 *
 * The `Indexer` subscribes to the **existing** `@framework/events` EventBus —
 * no second bus, no new worker. The bus routes on the resource channel
 * (`<index>`, e.g. `products`) and carries the verb in `event.type`
 * (`products.created`), so one subscription covers the four write events and
 * dispatches an index job each. Soft-delete awareness is mandatory: a `deleted`
 * event removes the document, `created`/`updated`/`restored` upsert the
 * projected row (a soft-deleted row carries the reserved marker and is filtered
 * by the engine).
 */
import { ExecutionContext, type JsonObject, type JsonValue } from '@framework/core';
import type { CrudTable, DatabaseConnection, SelectOf } from '@framework/database';
import type { DomainEvent, EventBus, Unsubscribe } from '@framework/events';
import { sql } from 'drizzle-orm';
import type { SearchIndexDeclaration } from './config-schema';
import { isSoftDeleted } from './engine';
import { projectSearchDocument } from './index-definition';
import type { IndexDispatcher } from './jobs';
import type { IndexerOptions, SearchDocument, SearchEngine, SearchIndex } from './types';

/** The write events the indexer reacts to (one verb per event type). */
const INDEX_VERBS = ['created', 'updated', 'deleted', 'restored'] as const;
export type IndexVerb = (typeof INDEX_VERBS)[number];

export interface IndexerDependencies {
  /** The shared event bus (never a new one). */
  readonly bus: EventBus;
  /** Queued dispatch (default). */
  readonly enqueue: IndexDispatcher;
  /** Inline dispatch (dev/tests; `IndexerOptions.inline`). */
  readonly inline: IndexDispatcher;
}

export class Indexer {
  constructor(private readonly deps: IndexerDependencies) {}

  /**
   * Subscribes to the index's resource channel on the shared bus and dispatches
   * an index job per write event. Returns an `Unsubscribe` that detaches the
   * channel. Async because the `EventBus.subscribe` seam is async.
   */
  async register<TTable extends CrudTable>(
    index: SearchIndex<TTable>,
    options: IndexerOptions = {},
  ): Promise<Unsubscribe> {
    return this.deps.bus.subscribe(index.name, (event) => this.#handle(index, event, options));
  }

  async #handle<TTable extends CrudTable>(
    index: SearchIndex<TTable>,
    event: DomainEvent,
    options: IndexerOptions,
  ): Promise<void> {
    const verb = verbOf(index.name, event.type);
    if (verb === null) return;
    const payload = asJsonObject(event.payload);
    if (payload === null) return;
    const id = readId(payload);
    if (id === null) return;

    const dispatch = options.inline ? this.deps.inline : this.deps.enqueue;
    const execution = new ExecutionContext('command', event.correlationId, event.actor);
    if (verb === 'deleted') {
      await dispatch({ index: index.name, operation: 'remove', documents: [], ids: [id] }, execution);
      return;
    }
    const document = index.project(asRow<TTable>(payload));
    await dispatch({ index: index.name, operation: 'upsert', documents: [document], ids: [] }, execution);
  }
}

/** The verb carried in `event.type` (`<channel>.<verb>`), or `null` for unrelated types. */
function verbOf(channel: string, type: string): IndexVerb | null {
  const prefix = `${channel}.`;
  if (!type.startsWith(prefix)) return null;
  const verb = type.slice(prefix.length);
  return isIndexVerb(verb) ? verb : null;
}

function isIndexVerb(value: string): value is IndexVerb {
  return INDEX_VERBS.some((verb) => verb === value);
}

/** The event payload is the JSON snapshot of the row; `project` reads it via `toJsonRow`. */
function asRow<TTable extends CrudTable>(payload: JsonObject): SelectOf<TTable> {
  return payload as SelectOf<TTable>;
}

/**
 * `Array.isArray` cannot narrow `readonly JsonValue[]` (its predicate is
 * `any[]`), so the array test goes through a named predicate that can.
 */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Narrows a `JsonValue` to a plain JSON object; `null` for arrays and primitives. */
function asJsonObject(value: JsonValue): JsonObject | null {
  if (typeof value !== 'object' || value === null || isJsonArray(value)) return null;
  return value;
}

function readId(payload: JsonObject): string | null {
  const id = payload.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return String(id);
  return null;
}

export interface ReindexOptions {
  /** Counts what would be written without touching the index. */
  readonly dryRun?: boolean;
}

export interface ReindexResult {
  readonly index: string;
  readonly indexed: number;
  readonly skipped: number;
}

/**
 * Re-imports one index from its source table: reads every row, projects the
 * declared searchable/filterable fields, skips soft-deleted rows and upserts
 * the rest (keyed by `id`). Never flushes first — `search:flush` is separate,
 * matching Scout's `import` vs `flush`.
 */
export async function reindexIndex(
  engine: SearchEngine,
  connection: DatabaseConnection,
  declaration: SearchIndexDeclaration,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  const fields = dedupe([...declaration.searchable, ...declaration.filterable]);
  const rows = await connection.db.execute<Record<string, unknown>>(
    sql`select * from ${sql.identifier(declaration.source)}`,
  );

  const documents: SearchDocument[] = [];
  let skipped = 0;
  for (const row of rows) {
    const document = projectSearchDocument(
      row,
      fields,
      declaration.softDelete ? declaration.softDeleteField : undefined,
    );
    if (document.id.length === 0 || isSoftDeleted(document.fields)) {
      skipped += 1;
      continue;
    }
    documents.push(document);
  }

  if (!options.dryRun && documents.length > 0) await engine.upsert(declaration.name, documents);
  return { index: declaration.name, indexed: documents.length, skipped };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
