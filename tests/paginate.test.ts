import { describe, expect, test } from 'bun:test';
import type { JsonObject, JsonValue } from '@framework/core';
import { MemorySearchEngine, SOFT_DELETE_FIELD } from '../src';

const doc = (id: string, fields: Record<string, JsonValue>) => ({ id, fields });
const softDeleted = (id: string, fields: Record<string, JsonValue>) => ({
  id,
  fields: { ...fields, [SOFT_DELETE_FIELD]: true } as JsonObject,
});

/** Five live documents (four mention "widget") plus one soft-deleted. */
async function seed(engine: MemorySearchEngine): Promise<void> {
  await engine.upsert('products', [
    doc('1', { name: 'Red Widget', category: 'tools' }),
    doc('2', { name: 'Widget Widget Widget', category: 'tools' }),
    doc('3', { name: 'Blue Gadget', category: 'toys' }),
    doc('4', { name: 'Widget Deluxe', category: 'toys' }),
    doc('5', { name: 'Retired Widget', category: 'tools' }),
    softDeleted('6', { name: 'Deleted Widget', category: 'tools' }),
  ]);
}

describe('MemorySearchEngine.paginate', () => {
  test('returns the shared Page shape with bounded meta', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate('products', { term: 'widget' }, { page: 1, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
  });

  test('walks every page without gaps or duplicates, in ranked order', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await engine.paginate('products', { term: 'widget' }, { page, limit: 3 });
      seen.push(...result.items.map((hit) => hit.id));
      expect(result.meta.total).toBe(4);
      expect(result.meta.totalPages).toBe(2);
    }
    // Ranked by term frequency (id "2" mentions widget three times), ties by id.
    expect(seen).toEqual(['2', '1', '4', '5']);
  });

  test('keeps the total when a page lies beyond the last one', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate('products', { term: 'widget' }, { page: 9, limit: 2 });
    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ page: 9, limit: 2, total: 4, totalPages: 2 });
  });

  test('returns everything in one page when the limit exceeds the total', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate('products', { term: 'widget' }, { page: 1, limit: 100 });
    expect(page.items).toHaveLength(4);
    expect(page.meta).toEqual({ page: 1, limit: 100, total: 4, totalPages: 1 });
  });

  test('combines exact-match filters with pagination', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate(
      'products',
      { term: 'widget', filters: { category: 'toys' } },
      { page: 1, limit: 10 },
    );
    expect(page.items.map((hit) => hit.id)).toEqual(['4']);
    expect(page.meta.total).toBe(1);

    const filtersOnly = await engine.paginate('products', { filters: { category: 'toys' } }, { page: 1, limit: 10 });
    expect(filtersOnly.items.map((hit) => hit.id)).toEqual(['3', '4']);
    expect(filtersOnly.meta.total).toBe(2);
  });

  test('excludes soft-deleted documents from pages and totals', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate('products', { term: 'widget' }, { page: 1, limit: 50 });
    expect(page.items.map((hit) => hit.id)).not.toContain('6');
    expect(page.meta.total).toBe(4);
    for (const hit of page.items) expect(hit.document.fields[SOFT_DELETE_FIELD]).toBeUndefined();
  });

  test('returns an empty page for an unknown index', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const page = await engine.paginate('missing', { term: 'widget' }, { page: 1, limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ page: 1, limit: 10, total: 0, totalPages: 1 });
  });

  test('orders pages exactly like the unpaginated search for the same query', async () => {
    const engine = new MemorySearchEngine();
    await seed(engine);
    const search = await engine.search('products', { term: 'widget' });
    const page = await engine.paginate('products', { term: 'widget' }, { page: 1, limit: search.total });
    expect(page.items.map((hit) => hit.id)).toEqual(search.hits.map((hit) => hit.id));
    expect(page.items.map((hit) => hit.score)).toEqual(search.hits.map((hit) => hit.score));
  });
});
