/**
 * @file index.js
 * @description Validated Cookie Fluffs API process startup without automatic migrations.
 */
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { assertSchemaReady, pool } from './db.js';
import { validateRuntimeConfig } from './runtime-config.js';

process.on('unhandledRejection', () => console.error('[api] Unhandled asynchronous failure.'));

export async function startServer({
  validate = validateRuntimeConfig,
  readiness = assertSchemaReady,
  appFactory = createApp,
  listen = (app, port) => app.listen(port, () => console.log(`[api] Cookie Fluffs API listening on port ${port}.`)),
} = {}) {
  const config = validate();
  await readiness();
  return listen(appFactory(), config.port);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer().catch(async (error) => {
    console.error(`[api] Startup failed: ${error.message}`);
    await pool?.end().catch(() => undefined);
    process.exitCode = 1;
  });
}
