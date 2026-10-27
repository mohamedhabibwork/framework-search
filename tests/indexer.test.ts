import { describe, expect, test } from 'bun:test';
import { ExecutionContext, type JsonValue } from '@framework/core';
import type { Database, DatabaseConnection } from '@framework/database';
import { createDomainEvent, MemoryEventBus } from '@framework/events';
import type { QueueManager } from '@framework/queue';
import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import {
  applyIndexJob,
  defineSearchIndex,
  Indexer,
  indexJobPayloadSchema,
  inlineIndexDispatcher,
  MemorySearchEngine,
  queuedIndexDispatcher,
  reindexIndex,
  searchIndexDeclarationSchema,
} from '../src';

const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  rank: integer('rank').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
});

const index = defineSearchIndex({
  name: 'products',
  source: products,
  searchable: ['name', 'description'],
  filterable: ['category'],
  softDelete: true,
});

const CONTEXT = new ExecutionContext('command', 'corr-indexer', { id: 'u-1', type: 'user' });

/**
 * Publishes the way `ResourceService.#publish` does: the bus channel is the
 * resource and the verb rides in `event.type`. The payload is cast once here
 * because the test deliberately builds both valid row snapshots and invalid
 * ones (the in-memory bus performs no payload validation).
 */
function publish(bus: MemoryEventBus, verb: string, payload: unknown): Promise<void> {
  return bus.publish(createDomainEvent('products', verb, payload as JsonValue, CONTEXT));
}

const row = (id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: 'Widget',
  description: 'a small widget',
  category: 'tools',
  rank: 1,
  deletedAt: null,
  ...overrides,
});

interface Dispatched {
  readonly job: string;
  readonly payload: unknown;
}

/** Records `QueueManager.dispatch` calls; the queue transport itself is not under test. */
function recordingQueue(): { readonly queue: QueueManager; readonly dispatched: Dispatched[] } {
  const dispatched: Dispatched[] = [];
  const queue = {
    async dispatch(definition: { readonly name: string }, payload: unknown) {
      dispatched.push({ job: definition.name, payload });
      return { id: `job-${dispatched.length}` };
    },
  } as unknown as QueueManager;
  return { queue, dispatched };
}

/** Minimal read-only seam: `reindexIndex` only calls `db.execute` on the connection. */
function connectionOf(rows: readonly Record<string, unknown>[]): DatabaseConnection {
  return {
    db: { execute: async () => rows } as unknown as Database,
    async close() {},
  } as unknown as DatabaseConnection;
}

describe('Indexer', () => {
  test('queues one index job per write event by default (queued transport)', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const { queue, dispatched } = recordingQueue();
    const indexer = new Indexer({
      bus,
      enqueue: queuedIndexDispatcher(engine, queue),
      inline: async () => {
        throw new Error('the inline dispatcher must not run in queued mode');
      },
    });
    const off = await indexer.register(index);
    try {
      await publish(bus, 'created', row(7));

      expect(dispatched).toEqual([
        {
          job: 'search.index',
          payload: {
            index: 'products',
            operation: 'upsert',
            documents: [{ id: '7', fields: { name: 'Widget', description: 'a small widget', category: 'tools' } }],
            ids: [],
          },
        },
      ]);
      // The write is queued, not applied: the engine is untouched until the job runs.
      expect(engine.size('products')).toBe(0);

      // The dispatched payload is schema-valid JSON and round-trips into the engine.
      await applyIndexJob(engine, indexJobPayloadSchema.parse(dispatched[0]?.payload));
      expect(engine.size('products')).toBe(1);
      expect((await engine.search('products', { term: 'widget' })).total).toBe(1);
    } finally {
      await off();
    }
  });

  test('applies the write inline in inline mode (dev/tests)', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const { queue, dispatched } = recordingQueue();
    const indexer = new Indexer({
      bus,
      enqueue: queuedIndexDispatcher(engine, queue),
      inline: inlineIndexDispatcher(engine),
    });
    const off = await indexer.register(index, { inline: true });
    try {
      await publish(bus, 'updated', row(7, { name: 'Red Widget' }));
      expect(dispatched).toHaveLength(0);
      expect(engine.size('products')).toBe(1);
      expect((await engine.search('products', { term: 'red' })).total).toBe(1);
    } finally {
      await off();
    }
  });

  test('maps deleted to remove and restored to re-upsert (soft-delete awareness)', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const indexer = new Indexer({ bus, enqueue: inlineIndexDispatcher(engine), inline: inlineIndexDispatcher(engine) });
    const off = await indexer.register(index, { inline: true });
    try {
      await publish(bus, 'created', row(9));
      expect(engine.size('products')).toBe(1);

      await publish(bus, 'deleted', { id: 9 });
      expect(engine.size('products')).toBe(0);

      await publish(bus, 'restored', row(9));
      expect(engine.size('products')).toBe(1);
    } finally {
      await off();
    }
  });

  test('upserts soft-deleted rows with the reserved marker so engines filter them', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const indexer = new Indexer({ bus, enqueue: inlineIndexDispatcher(engine), inline: inlineIndexDispatcher(engine) });
    const off = await indexer.register(index, { inline: true });
    try {
      await publish(bus, 'updated', row(11, { name: 'Ghost', deletedAt: '2026-01-01T00:00:00.000Z' }));
      expect(engine.size('products')).toBe(0);
      expect((await engine.search('products', { term: 'ghost' })).total).toBe(0);
    } finally {
      await off();
    }
  });

  test('ignores events that are not row snapshots and unrelated verbs', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const dispatched: unknown[] = [];
    const indexer = new Indexer({
      bus,
      enqueue: async (payload) => void dispatched.push(payload),
      inline: inlineIndexDispatcher(engine),
    });
    const off = await indexer.register(index, { inline: true });
    try {
      await publish(bus, 'created', [row(1)]);
      await publish(bus, 'created', 'not-an-object');
      await publish(bus, 'created', { name: 'no id here' });
      await publish(bus, 'archived', row(2));
      expect(dispatched).toHaveLength(0);
      expect(engine.size('products')).toBe(0);
    } finally {
      await off();
    }
  });

  test('stops dispatching once unsubscribed', async () => {
    const bus = new MemoryEventBus();
    const engine = new MemorySearchEngine();
    const indexer = new Indexer({ bus, enqueue: inlineIndexDispatcher(engine), inline: inlineIndexDispatcher(engine) });
    const off = await indexer.register(index, { inline: true });
    await publish(bus, 'created', row(1));
    expect(engine.size('products')).toBe(1);

    await off();
    await publish(bus, 'created', row(2));
    expect(engine.size('products')).toBe(1);
  });
});

describe('reindexIndex', () => {
  const declaration = searchIndexDeclarationSchema.parse({
    name: 'products',
    source: 'products',
    searchable: ['name', 'description'],
    filterable: ['category'],
    softDelete: true,
  });

  test('imports live rows and skips soft-deleted ones', async () => {
    const engine = new MemorySearchEngine();
    const result = await reindexIndex(
      engine,
      connectionOf([row(1, { name: 'Red' }), row(2, { name: 'Ghost', deletedAt: '2026-01-01T00:00:00.000Z' })]),
      declaration,
    );
    expect(result).toEqual({ index: 'products', indexed: 1, skipped: 1 });
    expect(engine.size('products')).toBe(1);
    expect((await engine.search('products', { term: 'red' })).total).toBe(1);
    expect((await engine.search('products', { term: 'ghost' })).total).toBe(0);
  });

  test('counts without writing in dry-run mode', async () => {
    const engine = new MemorySearchEngine();
    const result = await reindexIndex(
      engine,
      connectionOf([row(1, { name: 'Red' }), row(2, { name: 'Ghost', deletedAt: '2026-01-01T00:00:00.000Z' })]),
      declaration,
      { dryRun: true },
    );
    expect(result).toEqual({ index: 'products', indexed: 1, skipped: 1 });
    expect(engine.size('products')).toBe(0);
  });
});
