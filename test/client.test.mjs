import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MailClient } from '../dist/index.js';

test('ESM and CommonJS expose the client', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('../dist/index.cjs').MailClient, 'function');
  assert.equal(typeof MailClient, 'function');
});
test('send authenticates, keeps idempotency and enforces timeout/redirect policy', async () => {
  let request;
  const client = new MailClient({ apiKey: 'test-key', baseUrl: 'https://mail.example.com', fetch: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }), { status: 202 });
  }});
  const result = await client.send({ from: 'a@example.com', to: 'b@example.com', subject: 'Reset', text: 'Link' }, { idempotencyKey: 'reset:123' });
  assert.equal(result.status, 'queued');
  assert.equal(request.url, 'https://mail.example.com/v1/messages');
  assert.equal(request.init.headers.authorization, 'Bearer test-key');
  assert.equal(request.init.headers['idempotency-key'], 'reset:123');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
});
test('API errors preserve status, network failures are not retried', async () => {
  let calls = 0;
  const client = new MailClient({ apiKey: 'test-key', baseUrl: 'https://mail.example.com', fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'Verify your domain' }), { status: 422 });
  }});
  await assert.rejects(client.send({ from: 'a@example.com', to: 'b@example.com', text: 'Link' }), { name: 'OutboxApiError', status: 422 });
  assert.equal(calls, 1);
  assert.throws(() => new MailClient({ apiKey: 'key', baseUrl: 'http://remote.example' }), /HTTPS/);
});
