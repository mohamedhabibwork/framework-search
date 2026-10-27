import { type Page, type PageRequest, toPage } from '@framework/database';
import { DEFAULT_SEARCH_LIMIT } from '../constants';
import { assertQuerySupported, flattenFields, isSoftDeleted, tokenize, withoutSoftDelete } from '../engine';
import type { SearchCapabilities, SearchDocument, SearchEngine, SearchHit, SearchQuery, SearchResult } from '../types';

/**
 * In-memory search driver for development and tests. It performs real term
 * matching over the projected document fields, real exact-match filtering and
 * real pagination — it reports exactly those capabilities and no more.
 */
const MEMORY_CAPABILITIES: SearchCapabilities = {
  fullText: true,
  filters: true,
  typoTolerance: false,
  facets: false,
};

interface StoredDocument {
  readonly document: SearchDocument;
  readonly deleted: boolean;
}

interface Ranked {
  readonly document: SearchDocument;
  readonly score: number | null;
}

export class MemorySearchEngine implements SearchEngine {
  readonly name = 'memory';
  readonly capabilities: SearchCapabilities = MEMORY_CAPABILITIES;
  readonly #indexes = new Map<string, Map<string, StoredDocument>>();

  async upsert(index: string, documents: readonly SearchDocument[]): Promise<void> {
    const store = this.#store(index);
    for (const document of documents) {
      store.set(document.id, {
        document: { id: document.id, fields: withoutSoftDelete(document.fields) },
        deleted: isSoftDeleted(document.fields),
      });
    }
  }

  async remove(index: string, ids: readonly string[]): Promise<void> {
    const store = this.#indexes.get(index);
    if (!store) return;
    for (const id of ids) store.delete(id);
  }

  async flush(index: string): Promise<void> {
    this.#indexes.delete(index);
  }

  async search(index: string, query: SearchQuery): Promise<SearchResult> {
    assertQuerySupported(this, query);
    const ranked = this.#rank(index, query);
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
    const hits = ranked.slice(0, limit).map((entry) => toHit(entry));
    return { hits, total: ranked.length, capabilities: this.capabilities };
  }

  async paginate(index: string, query: SearchQuery, page: PageRequest): Promise<Page<SearchHit>> {
    assertQuerySupported(this, query);
    const ranked = this.#rank(index, query);
    const start = (page.page - 1) * page.limit;
    const items = ranked.slice(start, start + page.limit).map((entry) => toHit(entry));
    return toPage(items, ranked.length, page);
  }

  /** Number of live documents currently held for an index (diagnostics/tests). */
  size(index: string): number {
    const store = this.#indexes.get(index);
    if (!store) return 0;
    let live = 0;
    for (const entry of store.values()) if (!entry.deleted) live += 1;
    return live;
  }

  #store(index: string): Map<string, StoredDocument> {
    let store = this.#indexes.get(index);
    if (!store) {
      store = new Map();
      this.#indexes.set(index, store);
    }
    return store;
  }

  #rank(index: string, query: SearchQuery): readonly Ranked[] {
    const store = this.#indexes.get(index);
    if (!store) return [];
    const term = query.term?.trim() ?? '';
    const terms = term.length > 0 ? tokenize(term) : [];
    const filters = Object.entries(query.filters ?? {});
    const ranked: Ranked[] = [];
    for (const entry of store.values()) {
      if (entry.deleted) continue;
      if (!matchesFilters(entry.document, filters)) continue;
      if (terms.length === 0) {
        ranked.push({ document: entry.document, score: null });
        continue;
      }
      const score = scoreDocument(entry.document, terms);
      if (score > 0) ranked.push({ document: entry.document, score });
    }
    ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.document.id.localeCompare(b.document.id));
    return ranked;
  }
}

function toHit(entry: Ranked): SearchHit {
  return { id: entry.document.id, score: entry.score, document: entry.document };
}

function matchesFilters(
  document: SearchDocument,
  filters: readonly (readonly [string, string | number | boolean])[],
): boolean {
  return filters.every(([field, expected]) => {
    const actual = document.fields[field];
    if (actual === undefined || actual === null) return false;
    if (typeof actual === 'object') return JSON.stringify(actual) === String(expected);
    return String(actual) === String(expected);
  });
}

/** Term-frequency score across the flattened document; `0` means no term matched. */
function scoreDocument(document: SearchDocument, terms: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of tokenize(flattenFields(document.fields))) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let score = 0;
  for (const term of terms) score += counts.get(term) ?? 0;
  return score;
}
