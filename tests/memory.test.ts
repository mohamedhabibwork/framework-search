import { describe, expect, test } from 'bun:test';
import { ConfigError, FrameworkError, type JsonObject } from '@framework/core';
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import {
  assertQuerySupported,
  type CapabilityReporter,
  DEFAULT_SEARCH_LIMIT,
  defineSearchIndex,
  flattenFields,
  MemorySearchEngine,
  requireCapability,
  SOFT_DELETE_FIELD,
  tokenize,
} from '../src';

const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  rank: integer('rank').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('MemorySearchEngine', () => {
  const seed = async (engine: MemorySearchEngine): Promise<void> => {
    await engine.upsert('products', [
      { id: '1', fields: { name: 'Red Widget', description: 'a small widget', category: 'tools' } },
      { id: '2', fields: { name: 'Widget Widget Widget', description: 'widgets galore', category: 'tools' } },
      { id: '3', fields: { name: 'Blue Gadget', description: 'unrelated', category: 'toys' } },
    ]);
  };

  test('reports its capabilities honestly', () => {
    const engine = new MemorySearchEngine();
    expect(engine.name).toBe('memory');
    expect(engine.capabilities).toEqual({
      fullText: true,
      filters: true,
      typoTolerance: false,
      facets: false,
    });
  });

  test('indexes documents and ranks term matches by frequency', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const result = await engine.search('products', { term: 'widget' });
    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => hit.id)).toEqual(['2', '1']);
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[1]?.score ?? 0);
    expect(result.capabilities).toEqual(engine.capabilities);
  });

  test('returns an empty result for an unknown index or a non-matching term', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    expect((await engine.search('missing', { term: 'widget' })).total).toBe(0);
    expect((await engine.search('products', { term: 'absent' })).total).toBe(0);
  });

  test('applies exact-match filters, alone and combined with a term', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const combined = await engine.search('products', { term: 'widget', filters: { category: 'toys' } });
    expect(combined.total).toBe(0);

    const filtered = await engine.search('products', { term: 'widget', filters: { category: 'tools' } });
    expect(filtered.hits.map((hit) => hit.id).sort()).toEqual(['1', '2']);

    const filterOnly = await engine.search('products', { filters: { category: 'toys' } });
    expect(filterOnly.hits.map((hit) => hit.id)).toEqual(['3']);
    expect(filterOnly.hits[0]?.score).toBeNull();
  });

  test('paginates with the shared Page shape and bounded meta', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const first = await engine.paginate('products', { term: 'widget' }, { page: 1, limit: 1 });
    const second = await engine.paginate('products', { term: 'widget' }, { page: 2, limit: 1 });
    expect(first.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  });

  test('honours the query limit and the default limit', async () => {
    const engine = new MemorySearchEngine();
    const many: { id: string; fields: JsonObject }[] = [];
    for (let index = 0; index < DEFAULT_SEARCH_LIMIT + 5; index += 1) {
      many.push({ id: String(index), fields: { name: 'widget', description: 'widget' } });
    }
    await engine.upsert('many', many);
    expect((await engine.search('many', { term: 'widget' })).hits).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect((await engine.search('many', { term: 'widget', limit: 3 })).hits).toHaveLength(3);
  });

  test('remove drops documents and flush clears the index', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    await engine.remove('products', ['2']);
    expect((await engine.search('products', { term: 'widget' })).hits.map((hit) => hit.id)).toEqual(['1']);
    expect(engine.size('products')).toBe(2);
    await engine.flush('products');
    expect((await engine.search('products', { term: 'widget' })).total).toBe(0);
    expect(engine.size('products')).toBe(0);
    // Removing from an unknown index is a no-op.
    await engine.remove('unknown', ['x']);
  });

  test('excludes soft-deleted documents and never returns the reserved marker', async () => {
    const engine = new MemorySearchEngine();
    await engine.upsert('soft', [
      { id: 'live', fields: { name: 'Live Widget' } },
      { id: 'gone', fields: { name: 'Dead Widget', [SOFT_DELETE_FIELD]: true } },
    ]);
    const result = await engine.search('soft', { term: 'widget' });
    expect(result.hits.map((hit) => hit.id)).toEqual(['live']);
    expect(result.hits[0]?.document.fields[SOFT_DELETE_FIELD]).toBeUndefined();
  });
});

describe('capability honesty (ADR-11)', () => {
  const limited: CapabilityReporter = {
    name: 'limited',
    capabilities: { fullText: false, filters: true, typoTolerance: false, facets: false },
  };

  test('a query needing an unsupported capability throws CAPABILITY_UNSUPPORTED', () => {
    const error = captureError(() => assertQuerySupported(limited, { term: 'x' }));
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as FrameworkError).code).toBe('CAPABILITY_UNSUPPORTED');
    expect(() => assertQuerySupported(limited, { filters: { a: 'b' } })).not.toThrow();
  });

  test('requireCapability names the engine, capability and operation', () => {
    const error = captureError(() => requireCapability(limited, 'typoTolerance', 'a typo-tolerant search'));
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as FrameworkError).message).toContain('limited');
    expect((error as FrameworkError).message).toContain('typoTolerance');
    expect(() => requireCapability(limited, 'filters', 'filtered search')).not.toThrow();
  });
});

describe('tokenizer and field flattening', () => {
  test('tokenize lowercases and strips punctuation', () => {
    expect(tokenize('Hello, World! 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('   ')).toEqual([]);
  });

  test('flattenFields collects string, numeric, boolean and array members', () => {
    const fields: JsonObject = { a: 'x', b: 1, c: true, d: ['p', 'q'], e: null, f: { nested: 'ignored' } };
    expect(flattenFields(fields)).toBe('x 1 true p q');
  });
});

describe('defineSearchIndex', () => {
  test('projects the union of searchable and filterable fields', () => {
    const index = defineSearchIndex({
      name: 'products',
      source: products,
      searchable: ['name', 'description'],
      filterable: ['category'],
      softDelete: true,
    });
    expect(index.name).toBe('products');
    expect(index.source).toBe(products);
    expect(index.searchable).toEqual(['name', 'description']);
    expect(index.filterable).toEqual(['category']);
    expect(index.softDelete).toBe(true);

    const document = index.project({
      id: 7,
      name: 'Widget',
      description: 'A widget',
      category: 'tools',
      rank: 3,
      deletedAt: null,
    });
    expect(document).toEqual({
      id: '7',
      fields: { name: 'Widget', description: 'A widget', category: 'tools' },
    });
  });

  test('marks soft-deleted rows with the reserved field', () => {
    const index = defineSearchIndex({
      name: 'products',
      source: products,
      searchable: ['name'],
      softDelete: true,
    });
    const document = index.project({
      id: 8,
      name: 'Ghost',
      description: 'x',
      category: 'tools',
      rank: 0,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(document.fields[SOFT_DELETE_FIELD]).toBe(true);
  });

  test('defaults softDelete to false and omits the marker', () => {
    const index = defineSearchIndex({ name: 'products', source: products, searchable: ['name'] });
    expect(index.softDelete).toBe(false);
    const document = index.project({
      id: 9,
      name: 'Live',
      description: 'x',
      category: 'tools',
      rank: 0,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(document.fields[SOFT_DELETE_FIELD]).toBeUndefined();
  });

  test('accepts a custom projection', () => {
    const index = defineSearchIndex({
      name: 'products',
      source: products,
      project: (row) => ({ id: String(row.id), fields: { title: row.name } }),
    });
    const document = index.project({
      id: 10,
      name: 'Custom',
      description: 'x',
      category: 'tools',
      rank: 0,
      deletedAt: null,
    });
    expect(document).toEqual({ id: '10', fields: { title: 'Custom' } });
  });

  test('rejects an empty name and empty field names', () => {
    const error = captureError(() => defineSearchIndex({ name: '  ', source: products, searchable: [''] }));
    expect(error).toBeInstanceOf(ConfigError);
  });
});
