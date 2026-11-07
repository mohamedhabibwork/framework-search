import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FrameworkError, type JsonObject, type JsonValue } from '@framework/core';
import { createConnection, type DatabaseConnection } from '@framework/database';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { PostgresSearchEngine, SOFT_DELETE_FIELD } from '../src';

const doc = (id: string, fields: Record<string, JsonValue>) => ({ id, fields });

let database: TestDatabase;
let connection: DatabaseConnection;
let engine: PostgresSearchEngine;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 2 });
  engine = new PostgresSearchEngine(connection);
});

afterAll(async () => {
  await connection?.close();
  await database?.drop();
});

describe('PostgresSearchEngine against real PostgreSQL', () => {
  test('reports its capabilities honestly', () => {
    expect(engine.name).toBe('postgres');
    expect(engine.capabilities).toEqual({
      fullText: true,
      filters: true,
      typoTolerance: false,
      facets: false,
    });
  });

  test('uses a tsvector column with a GIN index and ranks by term frequency', async () => {
    await engine.upsert('ranking', [
      doc('1', { name: 'Red Widget', description: 'a small widget' }),
      doc('2', { name: 'Widget Widget Widget', description: 'widgets galore' }),
      doc('3', { name: 'Blue Gadget', description: 'unrelated' }),
    ]);

    const columns = await connection.sql<{ data_type: string }[]>`
      select data_type from information_schema.columns
      where table_name = 'search_ranking' and column_name = 'search_vector'`;
    expect(columns[0]?.data_type).toBe('tsvector');

    const indexes = await connection.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'search_ranking' and indexname = 'search_ranking_search_idx'`;
    expect(indexes[0]?.indexdef.toLowerCase()).toContain('using gin');

    const result = await engine.search('ranking', { term: 'widget' });
    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => hit.id)).toEqual(['2', '1']);
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[1]?.score ?? 0);
    expect(result.hits[0]?.document.fields.name).toBe('Widget Widget Widget');
  });

  test('matches only real terms — no typo tolerance, as reported', async () => {
    await engine.upsert('typo', [doc('1', { name: 'Widget' })]);
    expect((await engine.search('typo', { term: 'widget' })).total).toBe(1);
    expect((await engine.search('typo', { term: 'widgit' })).total).toBe(0);
  });

  test('applies jsonb filters, alone and combined with a term', async () => {
    await engine.upsert('filtering', [
      doc('1', { name: 'Widget Pro', category: 'tools' }),
      doc('2', { name: 'Widget Lite', category: 'toys' }),
    ]);
    const filtered = await engine.search('filtering', { term: 'widget', filters: { category: 'tools' } });
    expect(filtered.hits.map((hit) => hit.id)).toEqual(['1']);

    const filterOnly = await engine.search('filtering', { filters: { category: 'toys' } });
    expect(filterOnly.hits.map((hit) => hit.id)).toEqual(['2']);
    expect(filterOnly.hits[0]?.score).toBeNull();
  });

  test('paginates with the shared Page shape and a consistent total', async () => {
    await engine.upsert('paging', [
      doc('1', { name: 'Widget One' }),
      doc('2', { name: 'Widget Two' }),
      doc('3', { name: 'Widget Three' }),
    ]);
    const first = await engine.paginate('paging', { term: 'widget' }, { page: 1, limit: 2 });
    const second = await engine.paginate('paging', { term: 'widget' }, { page: 2, limit: 2 });
    expect(first.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(first.meta.total).toBe(second.meta.total);
  });

  test('excludes soft-deleted documents and never leaks the marker', async () => {
    await engine.upsert('softdel', [
      doc('live', { name: 'Live Widget' }),
      doc('gone', { name: 'Dead Widget', [SOFT_DELETE_FIELD]: true }),
    ]);
    const result = await engine.search('softdel', { term: 'widget' });
    expect(result.hits.map((hit) => hit.id)).toEqual(['live']);
    expect(result.total).toBe(1);
    expect(result.hits[0]?.document.fields[SOFT_DELETE_FIELD]).toBeUndefined();

    // Re-upserting the row as live brings it back.
    await engine.upsert('softdel', [doc('gone', { name: 'Dead Widget' })]);
    expect((await engine.search('softdel', { term: 'widget' })).total).toBe(2);
  });

  test('remove drops rows and flush clears the index', async () => {
    await engine.upsert('lifecycle', [doc('1', { name: 'Widget' }), doc('2', { name: 'Widget' })]);
    await engine.remove('lifecycle', ['1']);
    expect((await engine.search('lifecycle', { term: 'widget' })).total).toBe(1);
    await engine.flush('lifecycle');
    expect((await engine.search('lifecycle', { term: 'widget' })).total).toBe(0);
    // Operating on an index that was never created is a no-op, not an error.
    await engine.remove('never-created', ['x']);
    await engine.flush('never-created');
  });

  test('survives a term-less filter search without ranking', async () => {
    await engine.upsert('filters-only', [doc('1', { name: 'Widget', category: 'tools' })]);
    const result = await engine.search('filters-only', { filters: { category: 'tools' } });
    expect(result.total).toBe(1);
    expect(result.hits[0]?.score).toBeNull();
  });

  test('reports SEARCH_ENGINE_UNAVAILABLE when the database is unreachable', async () => {
    const offline = createConnection({
      url: 'postgres://framework:framework@127.0.0.1:1/framework',
      maxConnections: 1,
      connectTimeoutSeconds: 1,
    });
    const broken = new PostgresSearchEngine(offline);
    const error = await broken.search('anything', { term: 'x' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as FrameworkError).code).toBe('SEARCH_ENGINE_UNAVAILABLE');
    await offline.close().catch(() => undefined);
  });
});

describe('PostgresSearchEngine configuration', () => {
  test('rejects an invalid prefix or language at construction', () => {
    expect(() => new PostgresSearchEngine(connection, { prefix: 'bad prefix!' })).toThrow(FrameworkError);
    expect(() => new PostgresSearchEngine(connection, { language: 'EN' })).toThrow(FrameworkError);
  });

  test('rejects an index name without any identifier characters', async () => {
    const error = await engine.search('   ', { term: 'x' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as FrameworkError).code).toBe('BAD_REQUEST');
  });
});

describe('PostgresSearchEngine document fields', () => {
  test('stores and returns JSON fields unchanged', async () => {
    const fields: JsonObject = { name: 'Widget', price: 9.99, active: true, tags: ['a', 'b'] };
    await engine.upsert('fields', [doc('1', fields)]);
    const result = await engine.search('fields', { term: 'widget' });
    expect(result.hits[0]?.document.fields).toEqual(fields);
  });
});
