/**
 * @file account-security-service.test.js
 * @description Transaction rollback checks for password-change persistence failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { changeCustomerPassword } from './account-security-service.js';

test('rolls back password and version changes when persistence fails', async () => {
  const statements = [];
  const hash = await bcrypt.hash('Original1!Pass', 4);
  const client = {
    async query(text) {
      statements.push(text);
      if (text.includes('FROM users WHERE id')) {
        return { rows: [{
          id: 1, first_name: 'Safe', last_name: 'Customer', email: 'safe@example.test',
          password_hash: hash, auth_version: 1, account_status: 'active',
        }], rowCount: 1 };
      }
      if (text.includes('FROM auth_rate_limits')) return { rows: [], rowCount: 0 };
      if (text.startsWith('UPDATE users')) throw new Error('simulated write failure');
      return { rows: [], rowCount: 0 };
    },
    release() { statements.push('RELEASE'); },
  };
  const databasePool = { connect: async () => client };

  await assert.rejects(
    changeCustomerPassword(1, 'Original1!Pass', 'Replacement2!Pass', { databasePool }),
    /simulated write failure/,
  );
  assert.ok(statements.includes('ROLLBACK'));
  assert.equal(statements.at(-1), 'RELEASE');
  assert.equal(statements.includes('COMMIT'), false);
});
