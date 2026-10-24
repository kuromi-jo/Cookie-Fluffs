/**
 * @file payment-webhook.test.js
 * @description Signature, replay, reconciliation, mismatch, and state-transition tests.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { parsePaymongoEvent, reconcilePaymongoEvent, verifyPaymongoSignature } from './payment-webhook.js';

const secret = 'whsec_test';
const timestamp = 1_700_000_000;

function signed(body, time = timestamp) {
  const signature = crypto.createHmac('sha256', secret).update(`${time}.`).update(body).digest('hex');
  return `t=${time},te=${signature},li=`;
}

function payload(changes = {}) {
  return {
    data: {
      id: 'evt_test',
      type: 'event',
      attributes: {
        type: 'checkout_session.payment.paid',
        livemode: false,
        data: {
          id: 'cs_test',
          attributes: {
            reference_number: '123e4567-e89b-42d3-a456-426614174000',
            payments: [{
              id: 'pay_test',
              attributes: { amount: 18_825, currency: 'PHP', status: 'paid', source: { type: 'gcash' } },
            }],
            ...changes,
          },
        },
      },
    },
  };
}

function clientFor({
  duplicate = false,
  amount = 18_825,
  currency = 'PHP',
  status = 'active',
  providerPaymentId = null,
  paymentStatus = 'awaiting_payment',
} = {}) {
  const calls = [];
  return {
    calls,
    async query(text) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.startsWith('INSERT INTO payment_webhook_events')) return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ event_id: 'evt_test' }] };
      if (sql.startsWith('SELECT id, COALESCE(payment_method_v2')) return { rowCount: 1, rows: [{ id: 7, paymentMethod: 'gcash', paymentStatus }] };
      if (sql.startsWith('SELECT id, payment_method AS')) return { rowCount: 1, rows: [{ id: 8, paymentMethod: 'gcash', providerMethod: 'gcash', amountCentavos: amount, currency, status, providerPaymentId }] };
      if (sql.startsWith('SELECT pa.id')) return { rowCount: 1, rows: [{
        id: 8, orderId: 7, paymentMethod: 'gcash', providerMethod: 'gcash', amountCentavos: amount,
        currency, status, providerPaymentId, paymentStatus,
      }] };
      if (sql.includes('JOIN order_cancellation_requests')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('UPDATE payment_attempts') || sql.startsWith('UPDATE orders') || sql.startsWith('UPDATE payment_webhook_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('verifies test signatures with constant-time input and rejects forged or stale requests', () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  assert.equal(verifyPaymongoSignature(raw, signed(raw), secret, timestamp), true);
  assert.equal(verifyPaymongoSignature(raw, signed(Buffer.from('{}')), secret, timestamp), false);
  assert.equal(verifyPaymongoSignature(raw, signed(raw, timestamp - 301), secret, timestamp), false);
});

test('reconciles Payment Intent paid events and ignores a later failure transition', async () => {
  const paid = payload();
  paid.data.attributes.type = 'payment.paid';
  paid.data.attributes.data = {
    id: 'pay_intent_test',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'paid', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(paid));
  const client = clientFor();
  assert.deepEqual(
    await reconcilePaymongoEvent(client, parsePaymongoEvent(paid, raw), 'c'.repeat(64)),
    { duplicate: false, processed: true },
  );
  assert.ok(client.calls.some((sql) => sql.startsWith('SELECT pa.id')));

  paid.data.attributes.type = 'payment.failed';
  const lateRaw = Buffer.from(JSON.stringify(paid));
  const paidClient = clientFor({
    status: 'paid',
    providerPaymentId: 'pay_intent_test',
    paymentStatus: 'paid',
  });
  await reconcilePaymongoEvent(paidClient, parsePaymongoEvent(paid, lateRaw), 'd'.repeat(64));
  assert.equal(paidClient.calls.some((sql) => sql.startsWith("UPDATE payment_attempts SET status = 'failed'")), false);
});

test('records distinct matching success events without rewriting a settled Payment Intent', async () => {
  const paid = payload();
  paid.data.id = 'evt_distinct_matching_payment';
  paid.data.attributes.type = 'payment.paid';
  paid.data.attributes.data = {
    id: 'pay_intent_test',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'paid', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(paid));
  const client = clientFor({
    status: 'paid',
    providerPaymentId: 'pay_intent_test',
    paymentStatus: 'paid',
  });

  assert.deepEqual(
    await reconcilePaymongoEvent(client, parsePaymongoEvent(paid, raw), 'e'.repeat(64)),
    { duplicate: false, processed: true },
  );
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE payment_attempts SET provider_payment_id')), false);
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE orders SET payment_status')), false);
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE payment_webhook_events')), true);
});

test('rejects a different provider payment after a Payment Intent is settled', async () => {
  const paid = payload();
  paid.data.id = 'evt_conflicting_payment';
  paid.data.attributes.type = 'payment.paid';
  paid.data.attributes.data = {
    id: 'pay_conflicting',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'paid', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(paid));
  const client = clientFor({
    status: 'paid',
    providerPaymentId: 'pay_original',
    paymentStatus: 'paid',
  });

  await assert.rejects(
    () => reconcilePaymongoEvent(client, parsePaymongoEvent(paid, raw), 'f'.repeat(64)),
    (error) => error.status === 409,
  );
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE payment_webhook_events')), false);
});

test('records a matching late failure but rejects a conflicting provider payment', async () => {
  const failed = payload();
  failed.data.attributes.type = 'payment.failed';
  failed.data.attributes.data = {
    id: 'pay_intent_test',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'failed', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(failed));
  const matching = clientFor({
    status: 'paid',
    providerPaymentId: 'pay_intent_test',
    paymentStatus: 'paid',
  });
  await reconcilePaymongoEvent(matching, parsePaymongoEvent(failed, raw), '1'.repeat(64));
  assert.equal(matching.calls.some((sql) => sql.startsWith("UPDATE payment_attempts SET status = 'failed'")), false);

  failed.data.id = 'evt_conflicting_failure';
  failed.data.attributes.data.id = 'pay_conflicting';
  const conflictingRaw = Buffer.from(JSON.stringify(failed));
  const conflicting = clientFor({
    status: 'paid',
    providerPaymentId: 'pay_intent_test',
    paymentStatus: 'paid',
  });
  await assert.rejects(
    () => reconcilePaymongoEvent(conflicting, parsePaymongoEvent(failed, conflictingRaw), '2'.repeat(64)),
    (error) => error.status === 409,
  );
  assert.equal(conflicting.calls.at(-1), 'ROLLBACK');
});

test('records the first failed provider identity and keeps distinct matching failures unchanged', async () => {
  const failed = payload();
  failed.data.id = 'evt_failure_first';
  failed.data.attributes.type = 'payment.failed';
  failed.data.attributes.data = {
    id: 'pay_failed_test',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'failed', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(failed));
  const first = clientFor();
  await reconcilePaymongoEvent(first, parsePaymongoEvent(failed, raw), '3'.repeat(64));
  assert.equal(first.calls.some((sql) => sql.startsWith('UPDATE payment_attempts SET provider_payment_id')), true);
  assert.equal(first.calls.some((sql) => sql.startsWith("UPDATE orders SET payment_state = 'failed'")), true);

  failed.data.id = 'evt_failure_matching';
  const repeatedRaw = Buffer.from(JSON.stringify(failed));
  const repeated = clientFor({
    status: 'failed',
    providerPaymentId: 'pay_failed_test',
    paymentStatus: 'failed',
  });
  await reconcilePaymongoEvent(repeated, parsePaymongoEvent(failed, repeatedRaw), '4'.repeat(64));
  assert.equal(repeated.calls.some((sql) => sql.startsWith('UPDATE payment_attempts')), false);
  assert.equal(repeated.calls.some((sql) => sql.startsWith('UPDATE orders')), false);
  assert.equal(repeated.calls.some((sql) => sql.startsWith('UPDATE payment_webhook_events')), true);
});

test('rejects a different provider payment after a failed attempt is recorded', async () => {
  const failed = payload();
  failed.data.id = 'evt_failure_conflicting';
  failed.data.attributes.type = 'payment.failed';
  failed.data.attributes.data = {
    id: 'pay_failure_conflicting',
    attributes: { payment_intent_id: 'pi_test', amount: 18_825, currency: 'PHP', status: 'failed', source: { type: 'gcash' } },
  };
  const raw = Buffer.from(JSON.stringify(failed));
  const client = clientFor({
    status: 'failed',
    providerPaymentId: 'pay_failure_original',
    paymentStatus: 'failed',
  });

  await assert.rejects(
    () => reconcilePaymongoEvent(client, parsePaymongoEvent(failed, raw), '5'.repeat(64)),
    (error) => error.status === 409,
  );
  assert.equal(client.calls.at(-1), 'ROLLBACK');
});

test('parses the documented event envelope and reconciles exact paid values', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const event = parsePaymongoEvent(JSON.parse(raw), raw);
  const client = clientFor();
  const result = await reconcilePaymongoEvent(client, event, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(result, { duplicate: false, processed: true });
  assert.ok(client.calls.some((sql) => sql.startsWith('UPDATE orders SET payment_status')));
});

test('keeps legacy Hosted Checkout settlement timestamps unchanged for a matching payment', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const client = clientFor({ status: 'paid', providerPaymentId: 'pay_test', paymentStatus: 'paid' });
  const result = await reconcilePaymongoEvent(
    client,
    parsePaymongoEvent(JSON.parse(raw), raw),
    crypto.createHash('sha256').update(raw).digest('hex'),
  );
  assert.deepEqual(result, { duplicate: false, processed: true });
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE payment_attempts SET provider_payment_id')), false);
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE orders SET payment_status')), false);
});

test('parses the current Hosted Checkout webhook envelope', () => {
  const current = {
    event_type: 'send.webhook',
    data: {
      type: 'checkout_session.payment.paid',
      resource: 'checkout_session',
      livemode: false,
      data: payload().data.attributes.data,
    },
  };
  const raw = Buffer.from(JSON.stringify(current));
  const event = parsePaymongoEvent(current, raw);
  assert.equal(event.eventType, 'checkout_session.payment.paid');
  assert.equal(event.livemode, false);
  assert.equal(event.session.id, 'cs_test');
  assert.match(event.eventId, /^evt_sha256_[0-9a-f]{64}$/);
});

test('acknowledges duplicate events without repeating transitions', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const client = clientFor({ duplicate: true });
  const result = await reconcilePaymongoEvent(client, parsePaymongoEvent(JSON.parse(raw), raw), 'a'.repeat(64));
  assert.deepEqual(result, { duplicate: true, processed: false });
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE orders')), false);
});

test('rolls back amount or currency mismatches and late events for expired attempts', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const event = parsePaymongoEvent(JSON.parse(raw), raw);
  for (const client of [clientFor({ amount: 100 }), clientFor({ currency: 'USD' }), clientFor({ status: 'expired' })]) {
    await assert.rejects(() => reconcilePaymongoEvent(client, event, 'b'.repeat(64)));
    assert.equal(client.calls.at(-1), 'ROLLBACK');
    assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE orders')), false);
  }
});

test('ignores an unrelated event without changing an order', async () => {
  const body = payload();
  body.data.attributes.type = 'payment.refunded';
  const raw = Buffer.from(JSON.stringify(body));
  const client = clientFor();
  const result = await reconcilePaymongoEvent(
    client,
    parsePaymongoEvent(body, raw),
    crypto.createHash('sha256').update(raw).digest('hex'),
  );
  assert.deepEqual(result, { duplicate: false, processed: false });
  assert.equal(client.calls.some((sql) => sql.startsWith('UPDATE orders')), false);
});
