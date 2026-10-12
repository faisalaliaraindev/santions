/**
 * Dependency-injection tokens.
 *
 * In their own module on purpose. Declaring them in `app.module.ts` creates a circular import
 * — the module imports every controller, and a controller importing a token back from the
 * module produces a temporal-dead-zone crash at startup that reads as
 * "Cannot access 'APP_CONFIG' before initialization" and points at the wrong file.
 */

export const APP_CONFIG = 'APP_CONFIG';
export const MONGO_DB = 'MONGO_DB';
export const MONGO_CLIENT = 'MONGO_CLIENT';

/**
 * The SearXNG client, or null when no instance is configured.
 *
 * A token rather than the class, because the provider legitimately resolves to `null` and Nest
 * cannot inject a class token that has no instance. Null is a supported state: the rung-5
 * connector is still constructed, the gate refuses every query with
 * `INTERNAL_SERVICE_NOT_CONFIGURED`, and the coverage line says so.
 */
export const SEARXNG_CLIENT = 'SEARXNG_CLIENT';
