/**
 * @file auth.test.js
 * @description JWT claim and database-backed session revocation tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-cookie-fluffs-auth-secret-9821';

const { createRequireAuth, JWT_AUDIENCE, JWT_ISSUER, signToken } = await import('./auth.js');

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('issues explicit seven-day HS256 claims and accepts a matching active account', async () => {
  const token = signToken({ id: 7, auth_version: 3 });
  const decoded = jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
  });
  assert.equal(decoded.sub, '7');
  assert.equal(decoded.auth_version, 3);
  assert.match(decoded.jti, /^[0-9a-f-]{36}$/i);
  assert.ok(decoded.exp - decoded.iat >= (7 * 24 * 60 * 60) - 1);

  const authenticate = createRequireAuth(async (_text, params) => ({
    rows: [{ id: params[0], auth_version: 3, account_status: 'active' }], rowCount: 1,
  }));
  const request = { headers: { authorization: `Bearer ${token}` } };
  const response = responseRecorder();
  let continued = false;
  await authenticate(request, response, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(request.userId, 7);
});

test('rejects legacy, revoked, and deactivated sessions', async () => {
  const legacy = jwt.sign({ sub: 7 }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const current = signToken({ id: 7, auth_version: 2 });
  for (const testCase of [
    { token: legacy, row: { id: 7, auth_version: 2, account_status: 'active' } },
    { token: current, row: { id: 7, auth_version: 3, account_status: 'active' } },
    { token: current, row: { id: 7, auth_version: 2, account_status: 'deactivated' } },
  ]) {
    const authenticate = createRequireAuth(async () => ({ rows: [testCase.row], rowCount: 1 }));
    const response = responseRecorder();
    let continued = false;
    await authenticate(
      { headers: { authorization: `Bearer ${testCase.token}` } },
      response,
      () => { continued = true; },
    );
    assert.equal(continued, false);
    assert.equal(response.statusCode, 401);
  }
});

test('passes database availability failures to sanitized API error handling instead of revoking the session', async () => {
  const token = signToken({ id: 7, auth_version: 2 });
  const failure = new Error('private database detail');
  const authenticate = createRequireAuth(async () => { throw failure; });
  let received;
  await authenticate(
    { headers: { authorization: `Bearer ${token}` } },
    responseRecorder(),
    (error) => { received = error; },
  );
  assert.equal(received, failure);
});
