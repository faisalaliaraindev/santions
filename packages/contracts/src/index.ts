/**
 * `@erly/adverse-contracts` — the public API contract.
 *
 * One source of truth for request and response shapes, shared by the API, the generated
 * client and the OpenAPI document. Schemas are strict: unknown fields are rejected rather
 * than ignored, so a client typo fails loudly instead of being silently dropped.
 */

export * from './errors/errors.js';
export * from './subjects/subject.js';
export * from './searches/search.js';
export * from './searches/associations.js';
export * from './searches/findings.js';
export * from './admin/admin.js';
export * from './auth/session.js';
export * from './common/pagination.js';
export * from './common/health.js';
export * from './openapi/components.js';
export * from './openapi/document.js';
