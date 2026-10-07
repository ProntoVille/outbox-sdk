import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Outbox, OutboxError, OutboxApiError, OutboxConnectionError, MailClient, VERSION, verifyWebhook, WebhookVerificationError } from '../dist/index.js';

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

test('multi-recipient sends pass through and attachments bytes are base64-encoded', async () => {
  let sent;
  const mail = client(async (_u, init) => { sent = JSON.parse(init.body); return json({ id: ID, status: 'queued', recipients: [{ email: 'a@x.com', id: ID, status: 'queued', duplicate: false }, { email: 'b@x.com', id: ID, status: 'queued', duplicate: false }] }, 202); });
  const result = await mail.send({
    from: 'app@x.com', to: ['Ada <a@x.com>'], cc: 'b@x.com', bcc: ['c@x.com'], subject: 's', text: 't',
    headers: { 'X-Entity-Ref': 'inv-1' }, metadata: { order_id: '42' },
    attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('hi') }, { filename: 'b.txt', content: 'aGk=' }],
  });
  assert.equal(result.recipients.length, 2);
  assert.deepEqual(sent.attachments.map((a) => a.content), ['aGk=', 'aGk=']);
  assert.deepEqual(sent.cc, 'b@x.com');
  assert.deepEqual(sent.metadata, { order_id: '42' });
});

test('API errors expose code and request id', async () => {
  const mail = client(async () => json({ error: 'verify example.com', code: 'domain_not_verified', request_id: 'req_abc' }, 422));
  await assert.rejects(mail.send({ from: 'a@x.com', to: 'b@x.com', text: 't' }), (e) => e.code === 'domain_not_verified' && e.requestId === 'req_abc' && e.status === 422);
  const bare = client(async () => new Response('oops', { status: 400, headers: { 'x-request-id': 'req_hdr' } }));
  await assert.rejects(bare.send({ from: 'a@x.com', to: 'b@x.com', text: 't' }), (e) => e.code === 'error' && e.requestId === 'req_hdr');
});

test('an unreadable 2xx body is retried with the same key, then reported with it', async () => {
  const keys = [];
  const flaky = client(async (_u, init) => { keys.push(init.headers['idempotency-key']); return keys.length === 1 ? new Response('', { status: 202 }) : json({ id: ID, status: 'queued', duplicate: true }, 202); });
  assert.equal((await flaky.send({ from: 'a@x.com', to: 'b@x.com', text: 't' })).duplicate, true);
  assert.equal(keys[0], keys[1]);

  const broken = client(async () => new Response('<html>', { status: 202, headers: { 'x-request-id': 'req_1' } }), { maxRetries: 0 });
  await assert.rejects(broken.send({ from: 'a@x.com', to: 'b@x.com', text: 't' }), (e) =>
    e instanceof OutboxApiError && e.code === 'invalid_response' && e.status === 202 && e.requestId === 'req_1' && /^[0-9a-f-]{36}$/.test(e.idempotencyKey));
});

test('timeouts and network failures become OutboxConnectionError carrying the key', async () => {
  // AbortSignal.timeout's timer doesn't hold the event loop open; a real hung socket would.
  const socket = setTimeout(() => {}, 5_000);
  const hang = client((_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 20, maxRetries: 0 });
  await assert.rejects(hang.send({ from: 'a@x.com', to: 'b@x.com', text: 't' }, { idempotencyKey: 'order:7' }), (e) =>
    e instanceof OutboxConnectionError && e instanceof OutboxError && e.code === 'timeout' && e.idempotencyKey === 'order:7' && e.cause.name === 'TimeoutError');
  clearTimeout(socket);

  let calls = 0;
  const down = client(async () => { calls++; throw new TypeError('fetch failed'); }, { maxRetries: 1 });
  await assert.rejects(down.getMessage(ID), (e) => e instanceof OutboxConnectionError && e.code === 'connection_error' && e.idempotencyKey === null && e.cause instanceof TypeError);
  assert.equal(calls, 2);
});

test('Retry-After is honoured as seconds or an HTTP date and exposed on the error', async () => {
  const at = new Date(Date.now() + 5_000).toUTCString();
  const limited = client(async () => json({ error: 'slow down', code: 'rate_limited' }, 429, { 'retry-after': at }), { maxRetries: 0 });
  await assert.rejects(limited.getMessage(ID), (e) => e.code === 'rate_limited' && e.retryAfterMs > 3_000 && e.retryAfterMs <= 5_000);

  let calls = 0;
  const past = client(async () => (++calls === 1 ? json({ error: 'busy' }, 503, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }) : json({ id: ID })));
  const started = Date.now();
  assert.equal((await past.getMessage(ID)).id, ID);
  assert.ok(Date.now() - started < 1_000, 'a past date retries immediately');
});

test('the published types compile for CommonJS and ESM consumers', () => {
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '-p', fileURLToPath(new URL('types/tsconfig.json', import.meta.url))], { stdio: 'pipe' });
});

// Shared vector: the Go signer and PHP verifier are tested against the same values.
const VECTOR = {
  secret: 'whsec_b3V0Ym94LXNoYXJlZC10ZXN0LXZlY3Rvci1rZXktMzI=',
  body: '{"type":"message.delivered","created_at":"2026-10-06T16:00:00Z","data":{"message_id":"11111111-1111-4111-8111-111111111111","to":"ada@example.com","metadata":{"order_id":"42"}}}',
  headers: { 'Webhook-Id': 'msg_2Lrf8Kq', 'webhook-timestamp': '1791300000', 'webhook-signature': 'v0,bogus v1,MCdWC/xo85YYQTUvU1t7W9dodNDOfd581ZfFQByu58U=' },
  now: 1791300000 * 1000 + 60_000,
};

test('verifyWebhook accepts the shared vector and returns the event', async () => {
  const event = await verifyWebhook(VECTOR.body, VECTOR.headers, VECTOR.secret, { now: VECTOR.now });
  assert.equal(event.type, 'message.delivered');
  assert.equal(event.data.metadata.order_id, '42');
  const viaHeaders = await verifyWebhook(new TextEncoder().encode(VECTOR.body), new Headers(VECTOR.headers), VECTOR.secret, { now: VECTOR.now });
  assert.equal(viaHeaders.data.to, 'ada@example.com');
});

test('verifyWebhook rejects tampering, stale timestamps, wrong secrets and missing headers', async () => {
  const reject = (p) => assert.rejects(p, WebhookVerificationError);
  await reject(verifyWebhook(VECTOR.body.replace('42', '43'), VECTOR.headers, VECTOR.secret, { now: VECTOR.now }));
  await reject(verifyWebhook(VECTOR.body, VECTOR.headers, VECTOR.secret, { now: VECTOR.now + 10 * 60_000 }));
  await reject(verifyWebhook(VECTOR.body, VECTOR.headers, 'whsec_' + btoa('another-secret-another-secret!!'), { now: VECTOR.now }));
  await reject(verifyWebhook(VECTOR.body, { 'webhook-id': 'x' }, VECTOR.secret, { now: VECTOR.now }));
});
