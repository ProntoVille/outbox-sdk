import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Outbox, OutboxApiError, MailClient, VERSION } from '../dist/index.js';

const ID = '11111111-1111-4111-8111-111111111111';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const client = (fetch, opts = {}) => new Outbox({ apiKey: 'test-key', baseUrl: 'https://mail.example.com', fetch, ...opts });

test('ESM and CommonJS expose the client and legacy aliases', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../dist/index.cjs');
  assert.equal(typeof cjs.Outbox, 'function');
  assert.equal(typeof cjs.MailClient, 'function');
  assert.equal(MailClient, Outbox);
});

test('send authenticates and forwards replyTo, toName and the idempotency key', async () => {
  let request;
  const mail = client(async (url, init) => { request = { url, init }; return json({ id: ID, status: 'queued' }, 202); });
  const message = { from: 'a@example.com', fromName: 'App', to: 'b@example.com', toName: 'Ada Obi', replyTo: 'help@example.com', subject: 'Reset', text: 'Link' };
  const result = await mail.send(message, { idempotencyKey: 'reset:123' });
  assert.equal(result.status, 'queued');
  assert.equal(request.url, 'https://mail.example.com/v1/messages');
  assert.deepEqual(JSON.parse(request.init.body), message);
  assert.equal(request.init.headers.authorization, 'Bearer test-key');
  assert.equal(request.init.headers['idempotency-key'], 'reset:123');
  assert.equal(request.init.headers['user-agent'], `outbox-node/${VERSION}`);
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
});

test('send retries 5xx and network errors with one stable generated key', async () => {
  const keys = [];
  let calls = 0;
  const mail = client(async (_url, init) => {
    keys.push(init.headers['idempotency-key']);
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return json({ error: 'queue unavailable' }, 503, { 'retry-after': '0' });
    return json({ id: ID, status: 'queued' }, 202);
  });
  assert.equal((await mail.send({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' })).id, ID);
  assert.equal(calls, 3);
  assert.match(keys[0], /^[0-9a-f-]{36}$/);
  assert.ok(keys.every((k) => k === keys[0]));
});

test('4xx errors are not retried and keep status and body', async () => {
  let calls = 0;
  const mail = client(async () => { calls++; return json({ error: 'Verify your domain' }, 422); });
  await assert.rejects(mail.send({ from: 'a@example.com', to: 'b@example.com', text: 'Link' }), (e) => e instanceof OutboxApiError && e.status === 422 && e.message === 'Verify your domain' && e.body.error === 'Verify your domain');
  assert.equal(calls, 1);
});

test('retries stop at maxRetries and surface the last error', async () => {
  let calls = 0;
  const mail = client(async () => { calls++; return json({ error: 'busy' }, 429, { 'retry-after': '0' }); }, { maxRetries: 1 });
  await assert.rejects(mail.getMessage(ID), { status: 429 });
  assert.equal(calls, 2);
});

test('batch is retried only when every item has an idempotency key', async () => {
  let calls = 0;
  const mail = client(async () => { calls++; return json({ error: 'down' }, 502, { 'retry-after': '0' }); });
  const item = { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' };
  await assert.rejects(mail.sendBatch([item, { ...item, idempotencyKey: 'k2' }]), { status: 502 });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(mail.sendBatch([{ ...item, idempotencyKey: 'k1' }]), { status: 502 });
  assert.equal(calls, 3);
  assert.throws(() => mail.sendBatch([]), /1 to 100/);
});

test('listMessages builds the query and unwraps the list', async () => {
  let url;
  const mail = client(async (u) => { url = u; return json({ messages: [{ id: ID }] }); });
  assert.deepEqual(await mail.listMessages({ status: 'bounced', limit: 10 }), [{ id: ID }]);
  assert.equal(url, 'https://mail.example.com/v1/messages?status=bounced&limit=10');
});

test('caller abort stops retries immediately', async () => {
  const controller = new AbortController();
  let calls = 0;
  const mail = client(async () => { calls++; controller.abort(); throw new DOMException('aborted', 'AbortError'); });
  await assert.rejects(mail.getMessage(ID, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('configuration is validated before any secret is sent', () => {
  assert.throws(() => new Outbox({ apiKey: 'key', baseUrl: 'http://remote.example' }), /HTTPS/);
  assert.throws(() => new Outbox({ apiKey: 'key', baseUrl: 'https://u:p@remote.example' }), /origin/);
  assert.throws(() => new Outbox({ apiKey: 'key', maxRetries: -1 }), /maxRetries/);
  const saved = process.env.OUTBOX_API_KEY;
  delete process.env.OUTBOX_API_KEY;
  assert.throws(() => new Outbox(), /OUTBOX_API_KEY/);
  process.env.OUTBOX_API_KEY = 'from-env';
  assert.doesNotThrow(() => new Outbox());
  if (saved === undefined) delete process.env.OUTBOX_API_KEY; else process.env.OUTBOX_API_KEY = saved;
  assert.throws(() => client(async () => {}).getMessage('../api-keys'), /UUID/);
});
