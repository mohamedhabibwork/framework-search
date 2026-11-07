/**
 * Shared building blocks of the `SearchEngine` port (ADR-11): the honest
 * capability guard every driver must pass through, the soft-delete document
 * convention, and the tokenizer the built-in drivers share.
 *
 * A driver that cannot honour a request throws a catalogued
 * `CAPABILITY_UNSUPPORTED` error instead of degrading to a silent empty result
 * or a fake success.
 */
import { FrameworkError, type JsonObject, type JsonValue } from '@framework/core';
import { SOFT_DELETE_FIELD } from './constants';
import type { SearchCapabilities, SearchQuery } from './types';

/** A capability key a driver reports in its `SearchCapabilities`. */
export type SearchCapability = keyof SearchCapabilities;

/** Minimal engine view needed to police capabilities (any `SearchEngine` satisfies it). */
export interface CapabilityReporter {
  readonly name: string;
  readonly capabilities: SearchCapabilities;
}

/**
 * Throws `CAPABILITY_UNSUPPORTED` when `engine` cannot perform `operation`
 * because it lacks `capability`. Drivers call this instead of silently ignoring
 * a request they cannot honour (ADR-11).
 */
export function requireCapability(engine: CapabilityReporter, capability: SearchCapability, operation: string): void {
  if (engine.capabilities[capability]) return;
  throw new FrameworkError(
    'CAPABILITY_UNSUPPORTED',
    `Search engine "${engine.name}" cannot perform ${operation}: the "${capability}" capability is not supported`,
  );
}

/**
 * Guards a query against the engine's capabilities before it runs. A `term`
 * needs `fullText`; `filters` need `filters`. Unsupported requests throw rather
 * than silently returning an unfiltered or empty result (ADR-11).
 */
export function assertQuerySupported(engine: CapabilityReporter, query: SearchQuery): void {
  if (query.term !== undefined && query.term.trim() !== '') {
    requireCapability(engine, 'fullText', 'a full-text search');
  }
  if (query.filters !== undefined && Object.keys(query.filters).length > 0) {
    requireCapability(engine, 'filters', 'a filtered search');
  }
}

/** Splits text into lowercase alphanumeric terms (the built-in drivers' tokenizer). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length > 0);
}

/**
 * Flattens a document's JSON fields into one searchable text blob. Nested
 * objects are skipped; arrays contribute their string members.
 */
export function flattenFields(fields: JsonObject): string {
  const parts: string[] = [];
  for (const value of Object.values(fields)) {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    else if (Array.isArray(value))
      parts.push(value.filter((entry): entry is string => typeof entry === 'string').join(' '));
  }
  return parts.join(' ');
}

/** True when a projected document is marked soft-deleted. */
export function isSoftDeleted(fields: JsonObject): boolean {
  return fields[SOFT_DELETE_FIELD] === true;
}

/** Returns the fields without the reserved soft-delete marker (drivers never return it). */
export function withoutSoftDelete(fields: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === SOFT_DELETE_FIELD) continue;
    result[key] = value;
  }
  return result;
}
