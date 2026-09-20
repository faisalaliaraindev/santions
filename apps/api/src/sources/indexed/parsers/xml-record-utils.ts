import { decodeXml, parseXmlDocument } from '../../parse/xml.js';
import type { IndexedSourceDate } from '../indexed-source.types.js';

export function parseSafeXml(body: Uint8Array): Record<string, unknown> {
  const parsed = parseXmlDocument(decodeXml(body));
  if (parsed.kind !== 'OK') {
    throw new Error(parsed.detail);
  }
  const root = asRecord(parsed.document);
  if (root === null) {
    throw new Error('XML artifact has no object root.');
  }
  return root;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function records(value: unknown): readonly Record<string, unknown>[] {
  return asArray(value).map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
}

export function text(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim();
    return result === '' || result.toLowerCase() === 'na' ? null : result;
  }
  const item = asRecord(value);
  return item === null ? null : text(item['#text']);
}

export function texts(value: unknown): string[] {
  return unique(asArray(value).map(text).filter((item): item is string => item !== null));
}

export function joinName(parts: readonly unknown[]): string | null {
  const name = parts.map(text).filter((part): part is string => part !== null).join(' ').trim();
  return name === '' ? null : name;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))];
}

export function attr(record: Record<string, unknown>, name: string): string | null {
  return text(record[`@_${name}`]);
}

export function first(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

export function parseDate(value: unknown): IndexedSourceDate | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDay !== null) {
    return { value: raw, precision: 'DAY' };
  }
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (dmy !== null) {
    const [, day, month, year] = dmy;
    if (day !== undefined && month !== undefined && year !== undefined) {
      return { value: `${year}-${month}-${day}`, precision: 'DAY' };
    }
  }
  const year = /(?:^|\D)(\d{4})(?:\D|$)/.exec(raw)?.[1];
  if (year !== undefined) {
    return { value: `${year}-01-01`, precision: 'YEAR' };
  }
  return { value: null, precision: 'UNKNOWN' };
}

export function requireText(value: unknown, field: string): string {
  const result = text(value);
  if (result === null) {
    throw new Error(`Required publisher field ${field} is missing.`);
  }
  return result;
}

export function compactRaw(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return value;
}
