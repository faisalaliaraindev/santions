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
