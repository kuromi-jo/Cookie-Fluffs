/**
 * @file auth.test.js
 * @description Route-level checks for signup enforcement and legacy login compatibility.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.JWT_SECRET = 'test-only-cookie-fluffs-secret-9482';

const legacyPassword = 'legacy1';
const legacyHash = await bcrypt.hash(legacyPassword, 4);
const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = async (text) => {
  if (text.startsWith('SELECT * FROM users WHERE email')) {
    return {
      rows: [{
        id: 1,
        first_name: null,
        last_name: null,
        full_name: 'Legacy User',
        email: 'legacy@example.com',
        phone: '+639171234567',
        avatar: null,
        password_hash: legacyHash,
        created_at: new Date('2025-01-01T00:00:00Z'),
      }],
    };
  }
  throw new Error(`Unexpected test query: ${text}`);
};

const { createAuthRouter, default: router } = await import('./auth.js');
const { pool } = await import('../db.js');

after(async () => {
  pg.Pool.prototype.query = originalQuery;
  await pool?.end();
});

function routeHandler(path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path);
  assert.ok(layer, `Expected ${path} route`);
  return layer.route.stack[0].handle;
}

function authenticatedRouteHandler(testRouter, path, method) {
  const layer = testRouter.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('signup route rejects a password that bypasses frontend validation', async () => {
  const req = {
    body: {
      firstName: 'Maria',
      lastName: 'Santos',
      email: 'maria@example.com',
      phone: '0917 123 4567',
      password: 'lowercase1!',
    },
  };
  const res = responseRecorder();

  await routeHandler('/signup')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.errors.password, /uppercase/);
});

test('login route still accepts an existing password that predates the signup policy', async () => {
  const req = { body: { email: 'legacy@example.com', password: legacyPassword } };
  const res = responseRecorder();

  await routeHandler('/login')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.email, 'legacy@example.com');
  assert.equal(typeof res.body.token, 'string');
});

test('login rejects a deactivated account without disclosing its status', async () => {
  const testRouter = createAuthRouter(async () => ({
    rows: [{
      id: 2,
      full_name: 'Inactive Customer',
      email: 'inactive@example.test',
      phone: '+639171234567',
      password_hash: legacyHash,
      auth_version: 1,
      account_status: 'deactivated',
      created_at: new Date('2025-01-01T00:00:00Z'),
    }],
    rowCount: 1,
  }));
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/login', 'post')(
    { body: { email: 'inactive@example.test', password: legacyPassword } },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.message, 'Wrong email or password.');
});

test('profile read returns only the authenticated customer', async () => {
  const queries = [];
  const customer = {
    id: 7,
    first_name: 'Maria',
    last_name: 'Santos',
    full_name: 'Maria Santos',
    email: 'maria@example.test',
    phone: '+639171234567',
    avatar: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    return { rows: [customer], rowCount: 1 };
  });
  const req = { userId: 7 };
  const res = responseRecorder();

  await authenticatedRouteHandler(testRouter, '/me', 'get')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, customer.email);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [7]);
});

test('profile update scopes reads and writes to the authenticated customer', async () => {
  const queries = [];
  const current = {
    id: 9,
    first_name: 'Old',
    last_name: 'Name',
    full_name: 'Old Name',
    email: 'owner@example.test',
    phone: '+639171111111',
    avatar: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    if (text.startsWith('SELECT * FROM users WHERE id')) return { rows: [current], rowCount: 1 };
    return {
      rows: [{
        ...current,
        first_name: params[1],
        last_name: params[2],
        full_name: params[3],
        phone: params[4] ?? current.phone, // models COALESCE($5, phone)
        avatar: params[5],
      }],
      rowCount: 1,
    };
  });
  const req = {
    userId: 9,
    body: {
      firstName: 'New',
      lastName: 'Customer',
      avatar: 'data:image/jpeg;base64,cHJvZmlsZQ==',
    },
  };
  const res = responseRecorder();

  await authenticatedRouteHandler(testRouter, '/me', 'put')(req, res, (error) => { throw error; });

  assert.equal(res.body.fullName, 'New Customer');
  // Phone is preserved (COALESCE keeps the existing number; it is no longer editable here).
  assert.equal(res.body.phone, '+639171111111');
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].params, [9]);
  assert.equal(queries[1].params[0], 9);
});

test('profile update persists optional gender and date of birth for the owner', async () => {
  const queries = [];
  const current = {
    id: 5, first_name: 'Mara', last_name: 'Santos', full_name: 'Mara Santos',
    email: 'mara@example.test', phone: '+639171234567', avatar: null,
    gender: null, date_of_birth: null, created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    if (text.startsWith('SELECT * FROM users WHERE id')) return { rows: [current], rowCount: 1 };
    return {
      rows: [{ ...current, gender: params[7], date_of_birth: params[9] }],
      rowCount: 1,
    };
  });
  const res = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/me', 'put')(
    { userId: 5, body: { gender: 'non_binary', dateOfBirth: '1998-05-20' } },
    res, (error) => { throw error; },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.gender, 'non_binary');
  assert.equal(res.body.dateOfBirth, '1998-05-20');
  // Owner-scoped: the update is keyed on the authenticated user id.
  assert.equal(queries[1].params[0], 5);
});

test('profile update rejects an invalid gender and a future date of birth', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => { calls += 1; return { rows: [], rowCount: 0 }; });
  const handler = authenticatedRouteHandler(testRouter, '/me', 'put');

  const badGender = responseRecorder();
  await handler({ userId: 5, body: { gender: 'other' } }, badGender, (error) => { throw error; });
  assert.equal(badGender.statusCode, 400);
  assert.ok(badGender.body.errors.gender);

  const futureDob = responseRecorder();
  const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
  await handler({ userId: 5, body: { dateOfBirth: nextYear } }, futureDob, (error) => { throw error; });
  assert.equal(futureDob.statusCode, 400);
  assert.ok(futureDob.body.errors.dateOfBirth);

  // Rejected before any database write.
  assert.equal(calls, 0);
});

test('profile update no longer accepts phone (direct-edit bypass is closed)', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => { calls += 1; return { rows: [], rowCount: 0 }; });
  const res = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/me', 'put')(
    { userId: 5, body: { phone: '0917 123 4567' } }, res, (error) => { throw error; },
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Unknown profile field: phone/);
  assert.equal(calls, 0); // rejected before any DB write
});

test('change-phone route maps verified change, invalid phone, and unverified results', async () => {
  const changed = {
    id: 5, first_name: 'Mara', last_name: 'Santos', full_name: 'Mara Santos',
    email: 'mara@example.test', phone: '+639188887777', avatar: null, created_at: new Date(),
  };
  const okRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    changePhone: async (userId, input) => {
      assert.equal(userId, 5);
      assert.deepEqual(input, { challengeId: 'chal-1', newPhone: '0918 888 7777' });
      return { kind: 'changed', user: changed };
    },
  });
  const okRes = responseRecorder();
  await authenticatedRouteHandler(okRouter, '/change-phone', 'post')(
    { userId: 5, body: { challengeId: 'chal-1', newPhone: '0918 888 7777' } }, okRes, (e) => { throw e; },
  );
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.user.phone, '+639188887777');
  assert.equal('password_hash' in okRes.body.user, false);

  const invalidRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    changePhone: async () => ({ kind: 'invalid_phone' }),
  });
  const invalidRes = responseRecorder();
  await authenticatedRouteHandler(invalidRouter, '/change-phone', 'post')(
    { userId: 5, body: { challengeId: 'c', newPhone: '123' } }, invalidRes, (e) => { throw e; },
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.ok(invalidRes.body.errors.newPhone);

  const unverifiedRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    changePhone: async () => ({ kind: 'unverified' }),
  });
  const unverifiedRes = responseRecorder();
  await authenticatedRouteHandler(unverifiedRouter, '/change-phone', 'post')(
    { userId: 5, body: { challengeId: 'c', newPhone: '0918 888 7777' } }, unverifiedRes, (e) => { throw e; },
  );
  assert.equal(unverifiedRes.statusCode, 409);
});

test('change-phone route rejects extra or missing fields before the service', async () => {
  let calls = 0;
  const router = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    changePhone: async () => { calls += 1; return { kind: 'changed' }; },
  });
  const handler = authenticatedRouteHandler(router, '/change-phone', 'post');
  for (const body of [{ challengeId: 'c' }, { challengeId: 'c', newPhone: 'x', extra: 1 }, {}]) {
    const res = responseRecorder();
    await handler({ userId: 5, body }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('profile update rejects invalid and unapproved fields before querying', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => {
    calls += 1;
    return { rows: [], rowCount: 0 };
  });
  const handler = authenticatedRouteHandler(testRouter, '/me', 'put');
  const unknownResponse = responseRecorder();
  await handler({ userId: 1, body: { email: 'changed@example.test' } }, unknownResponse, (error) => { throw error; });
  assert.equal(unknownResponse.statusCode, 400);
  assert.match(unknownResponse.body.message, /Unknown profile field/);

  const invalidResponse = responseRecorder();
  await handler({ userId: 1, body: { firstName: 'M' } }, invalidResponse, (error) => { throw error; });
  assert.equal(invalidResponse.statusCode, 400);
  assert.ok(invalidResponse.body.errors.firstName);
  assert.equal(calls, 0);
});

test('password change returns one replacement session without exposing sensitive values', async () => {
  const changedUser = {
    id: 12,
    auth_version: 2,
    account_status: 'active',
    first_name: 'Mara',
    last_name: 'Santos',
    full_name: 'Mara Santos',
    email: 'mara@example.test',
    phone: '+639171234567',
    avatar: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  let received;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 12; next(); },
    changePassword: async (...args) => {
      received = args;
      return { kind: 'changed', user: changedUser };
    },
  });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/change-password', 'post')(
    { userId: 12, body: { currentPassword: 'Old1!Password', newPassword: 'Fresh2!Password', challengeId: 'cb811ba2-9458-4f3e-bc46-86a346448858' } },
    response,
    (error) => { throw error; },
  );

  assert.deepEqual(received, [12, 'Old1!Password', 'Fresh2!Password', 'cb811ba2-9458-4f3e-bc46-86a346448858']);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.email, changedUser.email);
  assert.equal(typeof response.body.token, 'string');
  assert.equal('password_hash' in response.body.user, false);
});

test('password change rejects extra fields and returns bounded throttling guidance', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 3; next(); },
    changePassword: async () => { calls += 1; return { kind: 'throttled', retryAfter: 420 }; },
  });
  const handler = authenticatedRouteHandler(testRouter, '/change-password', 'post');
  const invalidResponse = responseRecorder();
  await handler(
    { userId: 3, body: { currentPassword: 'Old1!Password', newPassword: 'Fresh2!Password', challengeId: 'cb811ba2-9458-4f3e-bc46-86a346448858', email: 'x' } },
    invalidResponse,
    (error) => { throw error; },
  );
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(calls, 0);

  const throttledResponse = { ...responseRecorder(), headers: {}, set(name, value) { this.headers[name] = value; } };
  await handler(
    { userId: 3, body: { currentPassword: 'Old1!Password', newPassword: 'Fresh2!Password', challengeId: 'cb811ba2-9458-4f3e-bc46-86a346448858' } },
    throttledResponse,
    (error) => { throw error; },
  );
  assert.equal(throttledResponse.statusCode, 429);
  assert.equal(throttledResponse.headers['Retry-After'], '420');
  assert.equal(throttledResponse.body.retryAfter, 420);
});

test('recovery config and disabled routes are explicit without issuing reset requests', async () => {
  let calls = 0;
  const recovery = {
    config: () => ({ enabled: false }),
    requestReset: async () => { calls += 1; },
    resetPassword: async () => { calls += 1; },
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { recovery });
  const configResponse = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/recovery-config', 'get')({}, configResponse, (error) => { throw error; });
  assert.deepEqual(configResponse.body, { enabled: false });

  const forgotResponse = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/forgot-password', 'post')(
    { body: { email: 'customer@example.test' }, ip: '127.0.0.1' },
    forgotResponse,
    (error) => { throw error; },
  );
  assert.equal(forgotResponse.statusCode, 503);
  assert.match(forgotResponse.body.message, /not available/i);
  assert.equal(calls, 0);
});

test('forgot-password returns the same accepted response without exposing account state', async () => {
  const recovery = {
    config: () => ({ enabled: true }),
    requestReset: async () => ({ kind: 'accepted', delivery: null }),
    deliverReset: async () => undefined,
    resetPassword: async () => ({ kind: 'changed' }),
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { recovery });
  const handler = authenticatedRouteHandler(testRouter, '/forgot-password', 'post');
  const first = responseRecorder();
  const second = responseRecorder();
  await handler({ body: { email: 'known@example.test' }, ip: '127.0.0.1' }, first, (error) => { throw error; });
  await handler({ body: { email: 'unknown@example.test' }, ip: '127.0.0.1' }, second, (error) => { throw error; });
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.body, second.body);
  assert.match(first.body.message, /If an account matches/i);
});

test('successful reset requires fresh login and never returns a JWT', async () => {
  const recovery = {
    config: () => ({ enabled: true }),
    requestReset: async () => ({ kind: 'accepted' }),
    deliverReset: async () => undefined,
    resetPassword: async () => ({ kind: 'changed' }),
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { recovery });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/reset-password', 'post')({
    body: {
      email: 'customer@example.test',
      code: '123456',
      newPassword: 'Fresh2!Password',
    },
  }, response, (error) => { throw error; });
  assert.equal(response.statusCode, 200);
  assert.match(response.body.message, /Log in/i);
  assert.equal('token' in response.body, false);
});

test('account-status returns owner-scoped sign-in method booleans without secrets', async () => {
  const queries = [];
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    return { rows: [{ hasPassword: true, googleLinked: false }], rowCount: 1 };
  }, { authenticate: (req, _res, next) => { req.userId = 42; next(); } });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/account-status', 'get')(
    { userId: 42 }, response, (error) => { throw error; },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { hasPassword: true, google: { linked: false } });
  // Owner-scoped: the query is filtered by the authenticated user id only.
  assert.deepEqual(queries[0].params, [42]);
  // No secret material is ever returned.
  const serialized = JSON.stringify(response.body);
  assert.equal(/password_hash|token|google_subject|hash/i.test(serialized), false);
});

test('account-status rejects a missing account with 401', async () => {
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 99; next(); },
  });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/account-status', 'get')(
    { userId: 99 }, response, (error) => { throw error; },
  );
  assert.equal(response.statusCode, 401);
});

test('Google routes expose disabled state without accepting credentials', async () => {
  let calls = 0;
  const googleAuth = {
    config: () => ({ enabled: false }),
    issueNonce: async () => { calls += 1; return { kind: 'disabled' }; },
    authenticate: async () => { calls += 1; return { kind: 'disabled', message: 'Unavailable.' }; },
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { googleAuth });
  const configResponse = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/google-config', 'get')({}, configResponse, (error) => { throw error; });
  assert.deepEqual(configResponse.body, { enabled: false });

  const nonceResponse = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/google/nonce', 'post')(
    { body: { intent: 'login' } }, nonceResponse, (error) => { throw error; },
  );
  assert.equal(nonceResponse.statusCode, 503);
  assert.equal(calls, 1);
});

test('Google nonce requires an explicit valid intent and never defaults to signup', async () => {
  let received;
  const googleAuth = {
    config: () => ({ enabled: true, webClientId: 'public-client' }),
    issueNonce: async (options) => { received = options; return { kind: 'issued', selector: 's', nonce: 'n' }; },
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { googleAuth });
  const handler = authenticatedRouteHandler(testRouter, '/google/nonce', 'post');

  // Missing intent is rejected before touching the service.
  const missing = responseRecorder();
  await handler({ body: {} }, missing, (error) => { throw error; });
  assert.equal(missing.statusCode, 400);
  assert.equal(received, undefined);

  // Unknown intent value is rejected.
  const bad = responseRecorder();
  await handler({ body: { intent: 'admin' } }, bad, (error) => { throw error; });
  assert.equal(bad.statusCode, 400);

  // Extra fields alongside intent are rejected.
  const extra = responseRecorder();
  await handler({ body: { intent: 'login', idToken: 'x' } }, extra, (error) => { throw error; });
  assert.equal(extra.statusCode, 400);

  // A valid intent passes through to issuance unchanged.
  const ok = responseRecorder();
  await handler({ body: { intent: 'signup' } }, ok, (error) => { throw error; });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(received, { intent: 'signup' });
});

test('Google authenticate forwards signup_needed and login_required as sanitized 409 guidance', async () => {
  const results = {
    signup_needed: {
      kind: 'signup_needed',
      message: 'No Cookie Fluffs account is linked to this Google account. Please sign up first.',
    },
    login_required: {
      kind: 'login_required',
      message: 'This Google account is already registered. Please log in instead.',
    },
  };
  for (const kind of Object.keys(results)) {
    const googleAuth = {
      config: () => ({ enabled: true, webClientId: 'public-client' }),
      authenticate: async () => results[kind],
    };
    const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { googleAuth });
    const response = responseRecorder();
    await authenticatedRouteHandler(testRouter, '/google/authenticate', 'post')(
      { body: { selector: 'selector', nonce: 'nonce', idToken: 'token' } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.kind, kind);
    assert.ok(response.body.message);
    assert.equal('token' in response.body, false);
    assert.equal('user' in response.body, false);
  }
});

test('Google authentication rejects unexpected fields before forwarding a token', async () => {
  let calls = 0;
  const googleAuth = {
    config: () => ({ enabled: true, webClientId: 'public-client' }),
    authenticate: async () => { calls += 1; return { kind: 'invalid', message: 'Invalid.' }; },
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { googleAuth });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/google/authenticate', 'post')(
    { body: { selector: 'selector', nonce: 'nonce', idToken: 'token', email: 'untrusted@example.test' } },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(calls, 0);
});

test('Google linking returns one sanitized restart-required response', async () => {
  const googleAuth = {
    config: () => ({ enabled: true, webClientId: 'public-client' }),
    linkAccount: async () => ({
      kind: 'restart_required',
      code: 'google_link_restart_required',
      message: "We couldn't confirm your Cookie Fluffs password. Select Continue with Google to try again.",
    }),
  };
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), { googleAuth });
  const response = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/google/link', 'post')(
    { body: { selector: 'selector', challenge: 'challenge', password: 'private-value' } },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    code: 'google_link_restart_required',
    message: "We couldn't confirm your Cookie Fluffs password. Select Continue with Google to try again.",
  });
});

test('reauth route routes password and Google methods and returns only an opaque proof id', async () => {
  let received;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 21; next(); },
    reauth: {
      verifyPassword: async (args) => { received = args; return { kind: 'authorized', reauthId: 'proof-pw' }; },
      completeGoogle: async (args) => { received = args; return { kind: 'authorized', reauthId: 'proof-g' }; },
      consumeReauth: async () => true,
    },
  });
  const handler = authenticatedRouteHandler(testRouter, '/reauth', 'post');

  const pwRes = responseRecorder();
  await handler({ userId: 21, body: { method: 'password', password: 'Secret1!Cookie' } }, pwRes, (e) => { throw e; });
  assert.equal(pwRes.statusCode, 201);
  assert.deepEqual(pwRes.body, { reauthId: 'proof-pw' });
  assert.equal(received.operation, 'change_email');
  assert.equal(JSON.stringify(pwRes.body).includes('Secret1!Cookie'), false); // password never echoed

  const gRes = responseRecorder();
  await handler({ userId: 21, body: { method: 'google', selector: 's', nonce: 'n', idToken: 't' } }, gRes, (e) => { throw e; });
  assert.equal(gRes.statusCode, 201);
  assert.deepEqual(gRes.body, { reauthId: 'proof-g' });
});

test('reauth route rejects unknown methods and extra fields before the service', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 21; next(); },
    reauth: {
      verifyPassword: async () => { calls += 1; return { kind: 'authorized', reauthId: 'x' }; },
      completeGoogle: async () => { calls += 1; return { kind: 'authorized', reauthId: 'x' }; },
      consumeReauth: async () => true,
    },
  });
  const handler = authenticatedRouteHandler(testRouter, '/reauth', 'post');
  for (const body of [{ method: 'sms', code: '1' }, { method: 'password' }, { method: 'password', password: 'x', extra: 1 }, {}]) {
    const res = responseRecorder();
    await handler({ userId: 21, body }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('reauth route maps a wrong password to a generic 400 (no detail leak)', async () => {
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 21; next(); },
    reauth: {
      verifyPassword: async () => ({ kind: 'invalid_password', message: 'That password is incorrect.' }),
      completeGoogle: async () => ({ kind: 'invalid' }),
      consumeReauth: async () => true,
    },
  });
  const res = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/reauth', 'post')(
    { userId: 21, body: { method: 'password', password: 'wrong' } }, res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'That password is incorrect.');
});

test('change-email route returns a fresh session on success and never exposes the hash', async () => {
  const changed = {
    id: 5, first_name: 'Mara', last_name: 'Santos', full_name: 'Mara Santos',
    email: 'new@example.test', phone: '+639171234567', avatar: null, auth_version: 3,
    account_status: 'active', password_hash: 'secret', created_at: new Date(),
  };
  let received;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 5; next(); },
    changeEmail: async (userId, input) => { received = { userId, input }; return { kind: 'changed', user: changed }; },
  });
  const res = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/change-email', 'post')(
    { userId: 5, body: { reauthId: 'proof-1', challengeId: 'chal-1', newEmail: 'new@example.test' } },
    res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.email, 'new@example.test');
  assert.equal(typeof res.body.token, 'string'); // rotated session token
  assert.equal('password_hash' in res.body.user, false);
  assert.deepEqual(received.input, { reauthId: 'proof-1', challengeId: 'chal-1', newEmail: 'new@example.test' });
});

test('change-email route maps invalid, duplicate, unauthorized, and unverified results', async () => {
  const cases = [
    { kind: 'invalid_email', status: 400, field: 'newEmail' },
    { kind: 'duplicate_email', status: 409, field: 'newEmail' },
    { kind: 'unauthorized', status: 401 },
    { kind: 'unverified', status: 409 },
  ];
  for (const c of cases) {
    const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
      authenticate: (req, _res, next) => { req.userId = 5; next(); },
      changeEmail: async () => ({ kind: c.kind }),
    });
    const res = responseRecorder();
    await authenticatedRouteHandler(testRouter, '/change-email', 'post')(
      { userId: 5, body: { reauthId: 'p', challengeId: 'c', newEmail: 'x@example.test' } }, res, (e) => { throw e; },
    );
    assert.equal(res.statusCode, c.status);
    if (c.field) assert.ok(res.body.errors[c.field]);
  }
});

test('change-email route rejects extra or missing fields before the service', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 5; next(); },
    changeEmail: async () => { calls += 1; return { kind: 'changed' }; },
  });
  const handler = authenticatedRouteHandler(testRouter, '/change-email', 'post');
  for (const body of [{ reauthId: 'p', challengeId: 'c' }, { reauthId: 'p', challengeId: 'c', newEmail: 'x', extra: 1 }, {}]) {
    const res = responseRecorder();
    await handler({ userId: 5, body }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('reauth route binds the proof to an allowlisted operation (default change_email)', async () => {
  let received;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 21; next(); },
    reauth: {
      verifyPassword: async (args) => { received = args; return { kind: 'authorized', reauthId: 'p' }; },
      completeGoogle: async (args) => { received = args; return { kind: 'authorized', reauthId: 'g' }; },
      consumeReauth: async () => true,
    },
  });
  const handler = authenticatedRouteHandler(testRouter, '/reauth', 'post');

  // Default (no operation) stays change_email for backward compatibility.
  const d = responseRecorder();
  await handler({ userId: 21, body: { method: 'password', password: 'Secret1!Cookie' } }, d, (e) => { throw e; });
  assert.equal(d.statusCode, 201);
  assert.equal(received.operation, 'change_email');

  // Explicit set_password via Google is honored.
  const s = responseRecorder();
  await handler({ userId: 21, body: { method: 'google', selector: 's', nonce: 'n', idToken: 't', operation: 'set_password' } }, s, (e) => { throw e; });
  assert.equal(s.statusCode, 201);
  assert.equal(received.operation, 'set_password');

  // An unknown operation is rejected before the service.
  const bad = responseRecorder();
  await handler({ userId: 21, body: { method: 'google', selector: 's', nonce: 'n', idToken: 't', operation: 'delete_account' } }, bad, (e) => { throw e; });
  assert.equal(bad.statusCode, 400);
});

test('set-password route returns a fresh session on success and never exposes the hash', async () => {
  const setUser = {
    id: 5, first_name: 'Google', last_name: 'Only', full_name: 'Google Only',
    email: 'g@example.test', phone: '+639170000000', avatar: null, auth_version: 2,
    account_status: 'active', password_hash: 'secret', created_at: new Date(),
  };
  let received;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 5; next(); },
    setPassword: async (userId, input) => { received = { userId, input }; return { kind: 'set', user: setUser }; },
  });
  const res = responseRecorder();
  await authenticatedRouteHandler(testRouter, '/set-password', 'post')(
    { userId: 5, body: { reauthId: 'p', challengeId: 'c', newPassword: 'Cookie1!Secret' } },
    res, (e) => { throw e; },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.email, 'g@example.test');
  assert.equal(typeof res.body.token, 'string');
  assert.equal('password_hash' in res.body.user, false);
  assert.deepEqual(received.input, { reauthId: 'p', challengeId: 'c', newPassword: 'Cookie1!Secret' });
  assert.equal(JSON.stringify(res.body).includes('Cookie1!Secret'), false); // password never echoed
});

test('set-password route maps password_exists, invalid_password, unauthorized, and unverified', async () => {
  const cases = [
    { kind: 'password_exists', status: 409 },
    { kind: 'invalid_password', message: 'Password needs at least 8 characters.', status: 400, field: 'newPassword' },
    { kind: 'unauthorized', status: 401 },
    { kind: 'unverified', status: 409 },
  ];
  for (const c of cases) {
    const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
      authenticate: (req, _res, next) => { req.userId = 5; next(); },
      setPassword: async () => ({ kind: c.kind, message: c.message }),
    });
    const res = responseRecorder();
    await authenticatedRouteHandler(testRouter, '/set-password', 'post')(
      { userId: 5, body: { reauthId: 'p', challengeId: 'c', newPassword: 'Cookie1!Secret' } }, res, (e) => { throw e; },
    );
    assert.equal(res.statusCode, c.status);
    if (c.field) assert.ok(res.body.errors[c.field]);
  }
});

test('set-password route rejects extra or missing fields before the service', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => ({ rows: [], rowCount: 0 }), {
    authenticate: (req, _res, next) => { req.userId = 5; next(); },
    setPassword: async () => { calls += 1; return { kind: 'set' }; },
  });
  const handler = authenticatedRouteHandler(testRouter, '/set-password', 'post');
  for (const body of [{ reauthId: 'p', challengeId: 'c' }, { reauthId: 'p', challengeId: 'c', newPassword: 'x', extra: 1 }, {}]) {
    const res = responseRecorder();
    await handler({ userId: 5, body }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});
