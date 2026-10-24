/**
 * @file paymongo-webhook.test.js
 * @description Webhook request-boundary rejection tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaymongoWebhookRouter } from './paymongo-webhook.js';

test('rejects forged webhook requests before database access', async () => {
  const dbPool = { connect: async () => { throw new Error('Database should not be reached.'); } };
  const router = createPaymongoWebhookRouter(dbPool, { enabled: true, webhookSecret: 'whsec_test' });
  const post = router.stack.find((layer) => layer.route?.path === '/').route.stack[0].handle;
  const req = { body: Buffer.from('{}'), get: () => 't=1,te=forged,li=' };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await post(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid payment notification.' });
});
