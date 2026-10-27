import { FrameworkError, type JsonObject } from '@framework/core';
import { type DatabaseConnection, type Page, type PageRequest, toPage } from '@framework/database';
import { type SQL, sql } from 'drizzle-orm';
import { DEFAULT_SEARCH_LIMIT } from '../constants';
import { assertQuerySupported, flattenFields, isSoftDeleted, tokenize, withoutSoftDelete } from '../engine';
import type { SearchCapabilities, SearchDocument, SearchEngine, SearchHit, SearchQuery, SearchResult } from '../types';

/**
 * PostgreSQL full-text search driver: one table per index with a `tsvector`
 * column and a `GIN` index. It uses only core PostgreSQL 17 (`to_tsvector`,
 * `to_tsquery`, `ts_rank`) — no `pg_trgm`, hence `typoTolerance: false`.
 *
 * Index tables are **derived** storage (rebuildable from the source table), so
 * the driver provisions them idempotently on first use rather than via an app
 * migration (ADR-9 governs source-of-truth app tables, not derived indexes).
 */
export interface PostgresSearchEngineOptions {
  /** Physical table prefix; one table `<prefix><index>` per index. Default `search_`. */
  readonly prefix?: string;
  /** Text-search configuration (`regconfig`). Default `english`. */
  readonly language?: string;
}

const POSTGRES_CAPABILITIES: SearchCapabilities = {
  fullText: true,
  filters: true,
  typoTolerance: false,
  facets: false,
};

type SearchRow = {
  readonly id: string;
  readonly document: JsonObject;
  readonly score: number | null;
};

export class PostgresSearchEngine implements SearchEngine {
  readonly name = 'postgres';
  readonly capabilities: SearchCapabilities = POSTGRES_CAPABILITIES;
  readonly #connection: DatabaseConnection;
  readonly #prefix: string;
  readonly #language: string;
  readonly #ensured = new Set<string>();

  constructor(connection: DatabaseConnection, options: PostgresSearchEngineOptions = {}) {
    this.#connection = connection;
    this.#prefix = options.prefix ?? 'search_';
    this.#language = options.language ?? 'english';
    if (!/^[a-z0-9_]*$/u.test(this.#prefix)) {
      throw new FrameworkError('BAD_REQUEST', `Invalid search prefix "${this.#prefix}"`);
    }
    if (!/^[a-z_]+$/u.test(this.#language)) {
      throw new FrameworkError('BAD_REQUEST', `Invalid search language "${this.#language}"`);
    }
  }

  async upsert(index: string, documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const tableName = this.#tableName(index);
    await this.#ensure(tableName);
    for (const document of documents) {
      const fields = withoutSoftDelete(document.fields);
      const deleted = isSoftDeleted(document.fields);
      const text = flattenFields(fields);
      const table = sql.identifier(tableName);
      await this.#execute(async () =>
        this.#connection.db.execute(sql`
          insert into ${table} (id, document, deleted, search_vector)
          values (
            ${document.id},
            ${JSON.stringify(fields)}::jsonb,
            ${deleted},
            to_tsvector(${this.#language}::regconfig, ${text})
          )
          on conflict (id) do update set
            document = excluded.document,
            deleted = excluded.deleted,
            search_vector = excluded.search_vector,
            updated_at = now()`),
      );
    }
  }

  async remove(index: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const tableName = this.#tableName(index);
    if (!(await this.#exists(tableName))) return;
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await this.#execute(async () =>
      this.#connection.db.execute(sql`
        delete from ${sql.identifier(tableName)} where id in (${list})`),
    );
  }

  async flush(index: string): Promise<void> {
    const tableName = this.#tableName(index);
    if (!(await this.#exists(tableName))) return;
    await this.#execute(async () => this.#connection.db.execute(sql`delete from ${sql.identifier(tableName)}`));
  }

  async search(index: string, query: SearchQuery): Promise<SearchResult> {
    assertQuerySupported(this, query);
    const tableName = this.#tableName(index);
    await this.#ensure(tableName);
    const { hits, total } = await this.#fetch(tableName, query);
    return { hits, total, capabilities: this.capabilities };
  }

  async paginate(index: string, query: SearchQuery, page: PageRequest): Promise<Page<SearchHit>> {
    assertQuerySupported(this, query);
    const tableName = this.#tableName(index);
    await this.#ensure(tableName);
    const { hits, total } = await this.#fetch(tableName, query, page);
    return toPage(hits, total, page);
  }

  /** Runs one statement, translating driver/connection failures into a catalogued error. */
  async #execute<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FrameworkError) throw error;
      if (isSqlState(errorCode(error))) throw error;
      throw new FrameworkError('SEARCH_ENGINE_UNAVAILABLE', `Search engine "${this.name}" is unavailable`, {
        cause: error,
      });
    }
  }

  async #exists(tableName: string): Promise<boolean> {
    const rows = await this.#execute(async () =>
      this.#connection.db.execute<{ present: boolean }>(sql`
        select to_regclass(${tableName}) is not null as present`),
    );
    return rows[0]?.present === true;
  }

  async #ensure(tableName: string): Promise<void> {
    if (this.#ensured.has(tableName)) return;
    const table = sql.identifier(tableName);
    await this.#execute(async () =>
      this.#connection.db.execute(sql`
        create table if not exists ${table} (
          id text primary key,
          document jsonb not null,
          deleted boolean not null default false,
          search_vector tsvector not null,
          updated_at timestamptz not null default now()
        )`),
    );
    await this.#execute(async () =>
      this.#connection.db.execute(sql`
        create index if not exists ${sql.identifier(`${tableName}_search_idx`)}
        on ${table} using gin (search_vector)`),
    );
    this.#ensured.add(tableName);
  }

  async #fetch(
    tableName: string,
    query: SearchQuery,
    page?: PageRequest,
  ): Promise<{ hits: SearchHit[]; total: number }> {
    const terms = query.term?.trim() ? tokenize(query.term) : [];
    const ranked = terms.length > 0;
    const where = this.#where(query, terms);
    const table = sql.identifier(tableName);
    const score = ranked
      ? sql`ts_rank(search_vector, to_tsquery(${this.#language}::regconfig, ${terms.join(' & ')}))`
      : sql`null::real`;
    const order = ranked ? sql`order by score desc, id asc` : sql`order by id asc`;
    const limit = page?.limit ?? query.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = page ? (page.page - 1) * page.limit : 0;

    const rows = await this.#execute(async () =>
      this.#connection.db.execute<SearchRow>(sql`
        select id, document, ${score} as score
        from ${table}
        where ${where}
        ${order}
        limit ${limit} offset ${offset}`),
    );
    const totals = await this.#execute(async () =>
      this.#connection.db.execute<{ total: number }>(sql`
        select count(*)::int as total from ${table} where ${where}`),
    );

    const hits: SearchHit[] = rows.map((row) => ({
      id: row.id,
      score: row.score === null ? null : Number(row.score),
      document: { id: row.id, fields: row.document },
    }));
    return { hits, total: totals[0]?.total ?? 0 };
  }

  /** Always excludes soft-deleted rows; adds the term and every filter as `and` conditions. */
  #where(query: SearchQuery, terms: readonly string[]): SQL {
    const conditions: SQL[] = [sql`deleted = false`];
    if (terms.length > 0) {
      conditions.push(sql`search_vector @@ to_tsquery(${this.#language}::regconfig, ${terms.join(' & ')})`);
    }
    for (const [field, value] of Object.entries(query.filters ?? {})) {
      conditions.push(sql`document ->> ${field} = ${String(value)}`);
    }
    return sql.join(conditions, sql` and `);
  }

  #tableName(index: string): string {
    const safe = index
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/gu, '_');
    if (safe.length === 0) {
      throw new FrameworkError('BAD_REQUEST', `Search index name "${index}" must contain a letter or digit`);
    }
    return `${this.#prefix}${safe}`;
  }
}

/** Reads the `code` property of an unknown thrown value without asserting its shape. */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** PostgreSQL SQLSTATE codes are five characters (`42P01`, `23505`, …). */
function isSqlState(code: unknown): boolean {
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code);
}
