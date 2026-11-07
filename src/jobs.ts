/**
 * The queued index write (`defineIndexJob`) over `@framework/queue`.
 *
 * Indexing is **queued by default** (design challenge C4): the `Indexer`
 * dispatches one job per event. Tests and dev can run the same write **inline**
 * through {@link applyIndexJob} — one code path, two transports, so the inline
 * path can never drift from the queued one.
 */
import type { ExecutionContext, JsonObject, JsonValue } from '@framework/core';
import { defineJob, type JobDefinition, type QueueManager } from '@framework/queue';
import { z } from 'zod/v4';
import { SEARCH_INDEX_JOB } from './constants';
import type { IndexJobPayload, IndexJobResult, SearchDocument, SearchEngine } from './types';

/** Sends one index write to its destination (queue in prod, engine inline in dev/tests). */
export type IndexDispatcher = (payload: IndexJobPayload, execution: ExecutionContext) => Promise<void>;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const searchDocumentSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), jsonValueSchema),
});

/** Validates the payload at the queue boundary; both arrays are always present. */
export const indexJobPayloadSchema = z.object({
  index: z.string().min(1),
  operation: z.enum(['upsert', 'remove']),
  documents: z.array(searchDocumentSchema),
  ids: z.array(z.string().min(1)),
});

/**
 * Applies one index write to `engine`. This is the whole effect of the index
 * job, so the inline dispatcher and the queued handler share it exactly.
 */
export async function applyIndexJob(engine: SearchEngine, payload: IndexJobPayload): Promise<IndexJobResult> {
  if (payload.operation === 'upsert') {
    await engine.upsert(payload.index, payload.documents);
    return { index: payload.index, operation: 'upsert', count: payload.documents.length };
  }
  await engine.remove(payload.index, payload.ids);
  return { index: payload.index, operation: 'remove', count: payload.ids.length };
}

/**
 * Queue-safe wire payload of the index job: the output of
 * {@link indexJobPayloadSchema}. `SearchDocument` is an interface without an
 * index signature, so it is not a `JsonValue` and the domain
 * {@link IndexJobPayload} cannot cross the queue boundary directly. Documents
 * therefore travel as fresh `{ id, fields }` literals produced by
 * {@link toJsonDocument} at the dispatch boundary. The wire payload stays
 * structurally assignable to the domain payload, so the handler forwards it to
 * {@link applyIndexJob} unchanged — one effect, two transports.
 */
export type IndexJobWirePayload = z.infer<typeof indexJobPayloadSchema>;

/**
 * The versioned index job. `upsert`/`remove` are idempotent (keyed by document
 * id), so the job retries safely under BullMQ's at-least-once delivery.
 */
export function defineIndexJob(engine: SearchEngine): JobDefinition<IndexJobWirePayload, IndexJobResult> {
  return defineJob({
    name: SEARCH_INDEX_JOB,
    version: 1,
    attempts: 5,
    backoffMs: 500,
    payload: indexJobPayloadSchema,
    async handle(payload): Promise<IndexJobResult> {
      return applyIndexJob(engine, payload);
    },
  });
}

/**
 * Projects one `SearchDocument` into a plain JSON literal at the dispatch
 * boundary: a fresh `{ id, fields }` object with a copied fields map, so no
 * interface instance ever reaches the queue.
 */
function toJsonDocument(document: SearchDocument): { readonly id: string; readonly fields: JsonObject } {
  return { id: document.id, fields: { ...document.fields } };
}

/** Queued dispatcher: enqueues the index job over `@framework/queue`. */
export function queuedIndexDispatcher(engine: SearchEngine, queue: QueueManager): IndexDispatcher {
  const job = defineIndexJob(engine);
  return async (payload, execution) => {
    const wire: IndexJobWirePayload = {
      ...payload,
      ids: [...payload.ids],
      documents: payload.documents.map(toJsonDocument),
    };
    await queue.dispatch(job, wire, execution);
  };
}

/** Inline dispatcher: applies the write immediately, skipping the queue (dev/tests). */
export function inlineIndexDispatcher(engine: SearchEngine): IndexDispatcher {
  return async (payload) => {
    await applyIndexJob(engine, payload);
  };
}
