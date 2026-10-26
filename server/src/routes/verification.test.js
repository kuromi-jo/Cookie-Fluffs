/**
 * @file verification.test.js
 * @description Route-level tests: owner-scoped auth, field validation, masked destination,
 * no raw code in responses, delivery gating, and Google-reauth routing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationRouter } from './verification.js';

function handler(router, path, method) {
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

const passthroughAuth = (req, _res, next) => { req.userId = 7; req.ip = '127.0.0.1'; next(); };

function buildRouter(overrides = {}) {
  return createVerificationRouter({
    dbQuery: async (text) => {
      // The current-user lookup returns the account; the change_email duplicate check finds none.
      if (typeof text === 'string' && text.startsWith('SELECT email, first_name')) {
        return { rows: [{ email: 'mara@example.test', first_name: 'Mara' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    authenticate: passthroughAuth,
    config: { deliveryEnabled: false, pepper: 'x'.repeat(40) },
    verification: {
      available: () => true,
      start: async () => ({ kind: 'started', challengeId: 'chal-1', operation: 'change_email', channel: 'email', expiresInMinutes: 10, code: '123456' }),
      verify: async () => ({ kind: 'verified', challengeId: 'chal-1', operation: 'change_email' }),
      consumeVerified: async () => true,
    },
    googleReauth: {
      available: () => true,
      issueNonce: async () => ({ kind: 'issued', selector: 'sel', nonce: 'non' }),
      verify: async () => ({ kind: 'verified' }),
    },
    ...overrides,
  });
}

test('start returns a masked destination and NEVER the raw code', async () => {
  const router = buildRouter();
  const res = response();
  // change_phone verifies via the CURRENT email, so the masked destination is the account email.
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_phone', target: '+639188887777' } },
    res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.challengeId, 'chal-1');
  assert.equal(res.body.maskedDestination, 'm•••@example.test');
  assert.equal(res.body.delivered, false); // delivery disabled
  assert.equal(res.body.deliveryEnabled, false);
  assert.equal('code' in res.body, false); // raw code never exposed
  assert.equal(JSON.stringify(res.body).includes('123456'), false);
});

test('start rejects unknown operations and extra fields', async () => {
  const router = buildRouter();
  for (const body of [{ operation: 'delete_account' }, { operation: 'change_email', extra: 1 }, {}]) {
    const res = response();
    await handler(router, '/start', 'post')({ userId: 7, ip: '127.0.0.1', body }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
  }
});

test('start maps throttle/cooldown to 429 with Retry-After', async () => {
  const router = buildRouter({
    verification: { available: () => true, start: async () => ({ kind: 'cooldown', retryAfter: 42, message: 'wait' }) },
  });
  const res = response();
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_phone' } }, res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '42');
});

test('start returns 503 when the engine is unavailable', async () => {
  const router = buildRouter({ verification: { available: () => false, start: async () => ({ kind: 'disabled' }) } });
  const res = response();
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_email' } }, res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 503);
});

test('verify returns the verified handle for a correct code', async () => {
  const router = buildRouter();
  const res = response();
  await handler(router, '/verify', 'post')(
    { userId: 7, body: { challengeId: 'chal-1', operation: 'change_email', code: '123456', target: 'new@example.test' } },
    res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { verified: true, challengeId: 'chal-1', operation: 'change_email' });
});

test('verify maps incorrect to 400 and locked to 429', async () => {
  const incorrect = buildRouter({ verification: { available: () => true, verify: async () => ({ kind: 'incorrect', message: 'bad' }) } });
  const r1 = response();
  await handler(incorrect, '/verify', 'post')({ userId: 7, body: { challengeId: 'c', operation: 'change_email', code: '000000', target: null } }, r1, (e) => { throw e; });
  assert.equal(r1.statusCode, 400);

  const locked = buildRouter({ verification: { available: () => true, verify: async () => ({ kind: 'locked', message: 'locked' }) } });
  const r2 = response();
  await handler(locked, '/verify', 'post')({ userId: 7, body: { challengeId: 'c', operation: 'change_email', code: '000000', target: null } }, r2, (e) => { throw e; });
  assert.equal(r2.statusCode, 429);
});

// Delivery-enabled routing: a fake adapter stands in for Brevo so we can assert the honest
// delivered/deliveryFailed/canRetry signals and the confirmed-rejection void, without real email.
function deliveryRouter({ send, voidSpy } = {}) {
  const calls = { void: [] };
  return {
    router: createVerificationRouter({
      dbQuery: async () => ({ rows: [{ email: 'mara@example.test', first_name: 'Mara' }], rowCount: 1 }),
      authenticate: passthroughAuth,
      config: { deliveryEnabled: true, pepper: 'x'.repeat(40) },
      verification: {
        available: () => true,
        start: async () => ({ kind: 'started', challengeId: 'chal-9', operation: 'change_phone', channel: 'email', expiresInMinutes: 10, code: '654321' }),
        voidFailedDelivery: async (args) => { calls.void.push(args); return (voidSpy ? voidSpy(args) : true); },
        verify: async () => ({ kind: 'verified' }),
        consumeVerified: async () => true,
      },
      emailAdapter: { sendVerificationCode: send ?? (async () => {}) },
    }),
    calls,
  };
}

async function runStart(router) {
  const res = response();
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_phone', target: '+639171234567' } },
    res, (e) => { throw e; },
  );
  return res;
}

test('delivery success reports delivered:true and keeps the challenge id', async () => {
  const { router, calls } = deliveryRouter({ send: async () => {} });
  const res = await runStart(router);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.delivered, true);
  assert.equal(res.body.deliveryFailed, false);
  assert.equal(res.body.canRetry, false);
  assert.equal(res.body.challengeId, 'chal-9');
  assert.equal(calls.void.length, 0); // nothing voided on success
  assert.equal(JSON.stringify(res.body).includes('654321'), false); // no OTP ever
});

test('confirmed provider rejection voids the challenge and allows immediate retry', async () => {
  const { VerificationDeliveryError } = await import('../verification-email.js');
  const { router, calls } = deliveryRouter({
    send: async () => { throw new VerificationDeliveryError('rejected'); },
  });
  const res = await runStart(router);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.delivered, false);
  assert.equal(res.body.deliveryFailed, true);
  assert.equal(res.body.canRetry, true);
  assert.equal(res.body.challengeId, null); // dead challenge id not handed back
  assert.equal(calls.void.length, 1); // voided exactly once
  assert.equal(calls.void[0].challengeId, 'chal-9');
  assert.equal(JSON.stringify(res.body).includes('654321'), false);
});

test('ambiguous delivery failure keeps the challenge and does NOT void or invite immediate retry', async () => {
  const { VerificationDeliveryError } = await import('../verification-email.js');
  const { router, calls } = deliveryRouter({
    send: async () => { throw new VerificationDeliveryError('ambiguous'); },
  });
  const res = await runStart(router);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.delivered, false);
  assert.equal(res.body.deliveryFailed, true);
  assert.equal(res.body.canRetry, false); // must wait; avoids duplicate sends
  assert.equal(res.body.challengeId, 'chal-9'); // challenge still usable if the email did arrive
  assert.equal(calls.void.length, 0); // never void an ambiguous outcome
  assert.equal(JSON.stringify(res.body).includes('654321'), false);
});

test('an untyped send error is treated as ambiguous (no void, no immediate retry)', async () => {
  const { router, calls } = deliveryRouter({
    send: async () => { throw new Error('boom'); },
  });
  const res = await runStart(router);
  assert.equal(res.body.delivered, false);
  assert.equal(res.body.deliveryFailed, true);
  assert.equal(res.body.canRetry, false);
  assert.equal(res.body.challengeId, 'chal-9');
  assert.equal(calls.void.length, 0);
});

test('change_email start delivers the OTP to the NEW email and masks it', async () => {
  let sentTo;
  const router = createVerificationRouter({
    dbQuery: async (text) => {
      if (text.startsWith('SELECT email, first_name')) {
        return { rows: [{ email: 'old@example.test', first_name: 'Mara' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 }; // duplicate check: not taken
    },
    authenticate: passthroughAuth,
    config: { deliveryEnabled: true, pepper: 'x'.repeat(40) },
    verification: {
      available: () => true,
      start: async () => ({ kind: 'started', challengeId: 'chal-e', operation: 'change_email', channel: 'email', expiresInMinutes: 10, code: '246810' }),
      voidFailedDelivery: async () => true,
      verify: async () => ({ kind: 'verified' }),
      consumeVerified: async () => true,
    },
    emailAdapter: { sendVerificationCode: async (m) => { sentTo = m.recipient; } },
  });
  const res = response();
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_email', target: 'NEW@Example.test' } },
    res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 201);
  assert.equal(sentTo, 'new@example.test'); // delivered to the normalized NEW address, not the old one
  assert.equal(res.body.maskedDestination, 'n••@example.test');
  assert.equal(JSON.stringify(res.body).includes('246810'), false); // no OTP in the response
});

test('change_email start rejects the current email and an address already in use', async () => {
  function router(dupTaken) {
    return createVerificationRouter({
      dbQuery: async (text) => {
        if (text.startsWith('SELECT email, first_name')) {
          return { rows: [{ email: 'old@example.test', first_name: 'Mara' }], rowCount: 1 };
        }
        return { rows: dupTaken ? [{ '?column?': 1 }] : [], rowCount: dupTaken ? 1 : 0 };
      },
      authenticate: passthroughAuth,
      config: { deliveryEnabled: true, pepper: 'x'.repeat(40) },
      verification: { available: () => true, start: async () => ({ kind: 'started', challengeId: 'c', operation: 'change_email', channel: 'email', expiresInMinutes: 10, code: '111111' }) },
      emailAdapter: { sendVerificationCode: async () => {} },
    });
  }
  // Same as current email → 409.
  const sameRes = response();
  await handler(router(false), '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_email', target: 'old@example.test' } }, sameRes, (e) => { throw e; },
  );
  assert.equal(sameRes.statusCode, 409);
  // Already in use by another account → 409 (generic, no owner disclosed).
  const dupeRes = response();
  await handler(router(true), '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_email', target: 'taken@example.test' } }, dupeRes, (e) => { throw e; },
  );
  assert.equal(dupeRes.statusCode, 409);
  assert.equal(dupeRes.body.message.includes('taken@example.test'), false);
});

test('change_email start rejects an invalid new email with 400', async () => {
  const router = createVerificationRouter({
    dbQuery: async () => ({ rows: [{ email: 'old@example.test', first_name: 'Mara' }], rowCount: 1 }),
    authenticate: passthroughAuth,
    config: { deliveryEnabled: true, pepper: 'x'.repeat(40) },
    verification: { available: () => true, start: async () => ({ kind: 'started' }) },
    emailAdapter: { sendVerificationCode: async () => {} },
  });
  const res = response();
  await handler(router, '/start', 'post')(
    { userId: 7, ip: '127.0.0.1', body: { operation: 'change_email', target: 'not-an-email' } }, res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 400);
});

test('google reauth nonce and verify route correctly; not-linked is 409', async () => {
  const router = buildRouter();
  const nonceRes = response();
  await handler(router, '/google/nonce', 'post')({ userId: 7, body: {} }, nonceRes, (e) => { throw e; });
  assert.equal(nonceRes.statusCode, 201);
  assert.deepEqual(nonceRes.body, { selector: 'sel', nonce: 'non' });

  const verifyRes = response();
  await handler(router, '/google/verify', 'post')(
    { userId: 7, body: { selector: 'sel', nonce: 'non', idToken: 'token' } }, verifyRes, (e) => { throw e; },
  );
  assert.equal(verifyRes.statusCode, 200);
  assert.deepEqual(verifyRes.body, { verified: true });

  const notLinked = buildRouter({ googleReauth: { issueNonce: async () => ({ kind: 'not_linked' }) } });
  const nl = response();
  await handler(notLinked, '/google/nonce', 'post')({ userId: 7, body: {} }, nl, (e) => { throw e; });
  assert.equal(nl.statusCode, 409);
});
