/**
 * @file migrate.js
 * @description Explicit advisory-locked database migration command for deployments.
 */
import { pathToFileURL } from 'node:url';
import { assertSchemaReady, migrateWithLock, pool } from './db.js';
import { validateRuntimeConfig } from './runtime-config.js';

export async function runMigrationCommand({
  validate = validateRuntimeConfig,
  migrate = migrateWithLock,
  readiness = assertSchemaReady,
  close = () => pool?.end(),
} = {}) {
  try {
    validate();
    await migrate();
    await readiness();
  } finally {
    await close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMigrationCommand()
    .then(() => console.log('[migration] Database schema is ready.'))
    .catch(async (error) => {
      console.error(`[migration] Failed: ${error.message}`);
      await pool?.end().catch(() => undefined);
      process.exitCode = 1;
    });
}
