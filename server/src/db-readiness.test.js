/**
 * @file db-readiness.test.js
 * @description Schema readiness and migration-lock tests without a database connection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSchemaReady, inspectSchemaReadiness, migrateWithLock } from './db.js';

test('reports ready only when all required tables and completed migration markers exist', async () => {
  const queryFn = async (sql, [required]) => ({
    rows: required.map((value) => (sql.includes('to_regclass') ? { name: value } : { key: value })),
  });
  assert.deepEqual(await inspectSchemaReadiness(queryFn), { ready: true });
});

test('sanitizes database and incomplete-schema readiness failures', async () => {
  assert.deepEqual(await inspectSchemaReadiness(async () => { throw new Error('private database detail'); }), { ready: false });
  await assert.rejects(() => assertSchemaReady(async () => ({ rows: [] })), /schema is not ready/i);
});

test('migration lock rejects concurrency and always releases its client', async () => {
  let released = false;
  const databasePool = {
    connect: async () => ({
      query: async () => ({ rows: [{ locked: false }] }),
      release: () => { released = true; },
    }),
  };
  await assert.rejects(() => migrateWithLock(databasePool, async () => undefined), /already running/i);
  assert.equal(released, true);
});

test('migration lock is released after migration failure', async () => {
  const statements = [];
  let released = false;
  const databasePool = {
    connect: async () => ({
      query: async (sql) => {
        statements.push(sql);
        return { rows: [{ locked: true }] };
      },
      release: () => { released = true; },
    }),
  };
  await assert.rejects(() => migrateWithLock(databasePool, async () => { throw new Error('migration failed'); }), /migration failed/);
  assert.equal(statements.some((sql) => sql.includes('pg_advisory_unlock')), true);
  assert.equal(released, true);
});
