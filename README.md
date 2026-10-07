# @getoutbox/sdk

Outbox Stack SDK for server-side transactional email. Node.js 20.3+, ESM and CommonJS, zero runtime dependencies.

```sh
npm install @getoutbox/sdk
```

Before sending: create an account, enable managed sending (or connect a provider), verify your sender domain, then create an API key in **Developers**. Store it in your backend's secret manager as `OUTBOX_API_KEY`.

## Send

```ts
import { Outbox, OutboxApiError } from '@getoutbox/sdk';

const outbox = new Outbox(); // reads OUTBOX_API_KEY; base URL defaults to https://outboxstack.app

const { id } = await outbox.send({
  from: 'accounts@your-verified-domain.com',
  fromName: 'Your app',
  to: 'ada@example.com',
  toName: 'Ada Obi',
  replyTo: 'support@your-verified-domain.com',
  subject: 'Reset your password',
  text: `Reset your password: ${resetUrl}`,
}, { idempotencyKey: `password-reset:${resetRequestId}` });
```

CommonJS: `const { Outbox } = require('@getoutbox/sdk');`

| Field | |
|---|---|
| `to`, `from` | Required. `from` must be on a verified domain. `to` may be a list. |
| `cc`, `bcc` | One address or a list. Bcc addresses never appear in headers. |
| `toName`, `fromName` | Display names. Or write addresses as `Ada Obi <ada@example.com>`. |
| `replyTo` | Where replies go, e.g. a support inbox. |
| `subject` + `html` and/or `text` | Message content. A text part is generated from `html` when omitted. |
| `template` + `data` | Template id or slug, in place of subject and body. Missing variables return 422. |
| `attachments` | Up to 10 files, 10 MB in total. `content` is a base64 string or bytes. Set `contentId` to embed an image as `cid:…`. |
| `headers` | Up to 20 custom headers, e.g. `X-Entity-Ref`. |
| `metadata` | Up to 10 strings of your own (order id, user id), returned by `getMessage()` and in webhooks. |

`send()` resolves when the message is **queued**, not delivered. Track it with `getMessage()` or signed webhooks.

Every address in `to`, `cc` and `bcc` (at most 50) becomes its own message with its own id, status and bounce tracking, and counts as one email for billing. `result.id` is the first recipient's; `result.recipients` lists them all. Each copy shows the full To and Cc lines. Multiple recipients need managed sending, SES or SMTP; a Cloudflare or ZeptoMail route returns `unsupported_by_provider`.

```ts
import { readFile } from 'node:fs/promises';

await outbox.send({
  from: 'billing@your-verified-domain.com',
  to: 'Ada Obi <ada@example.com>',
  bcc: 'archive@your-verified-domain.com',
  subject: 'Your invoice',
  html: '<p>Invoice attached.</p>',
  attachments: [{ filename: 'invoice.pdf', content: await readFile('invoice.pdf') }],
  metadata: { invoice_id: 'inv_123' },
});
```

## Batch, status and history

```ts
const batch = await outbox.sendBatch(users.map((u) => ({
  from: 'news@your-verified-domain.com', to: u.email, toName: u.name,
  template: 'weekly-digest', data: { name: u.name },
  idempotencyKey: `digest:2026-41:${u.id}`,
})));
for (const r of batch.results) if ('error' in r) console.warn(r.index, r.error);

const message = await outbox.getMessage(id);            // status, attempts, last_error, …
const bounced = await outbox.listMessages({ status: 'bounced', limit: 100 });
```

`sendBatch` takes 1–100 messages. Items succeed or fail independently, so the call resolves even when some items fail.

## Retries and idempotency

Timeouts, network errors, 429 and 5xx are retried up to `maxRetries` times (default 2), using `Retry-After` when the API sends it and jittered exponential backoff otherwise. 4xx errors are never retried.

A retry never sends twice. `send()` always carries an idempotency key and generates one when you don't pass one. Pass your own key, derived from the event that triggered the email, to stay safe across process restarts and job re-runs as well. `sendBatch` retries only when **every** item has an `idempotencyKey`.

## Errors

```ts
try {
  await outbox.send(message);
} catch (e) {
  if (!(e instanceof OutboxApiError)) throw e; // network error or timeout after retries, or AbortError
  if (e.code === 'domain_not_verified') { /* prompt to finish DNS setup */ }
  console.error(e.status, e.code, e.message, e.requestId); // quote requestId to support
}
```

Branch on `e.code`; the message text may change. Common codes:

| Code | Status | Meaning |
|---|---|---|
| `invalid_request`, `invalid_address`, `invalid_attachment`, `invalid_header`, `too_many_recipients` | 400 | Fix the request. |
| `unauthorized` / `forbidden`, `sender_domain_not_allowed` | 401 / 403 | Bad key, or a sending key used outside its scope or domain. |
| `quota_exceeded` | 402 | Monthly allowance and credits used up. |
| `template_not_found` | 404 | No template with that id or slug. |
| `domain_not_verified`, `sending_not_configured`, `missing_template_data`, `unsupported_by_provider` | 422 | Fix your setup or data. |
| `rate_limited`, `sandbox_limit_reached` | 429 | Retried automatically. |

The full list is in the [OpenAPI spec](https://outboxstack.app/openapi.json).

## Webhooks

Verify every webhook before trusting it. Pass the **raw** request body, not re-serialised JSON:

```ts
import { verifyWebhook, WebhookVerificationError } from '@getoutbox/sdk';

app.post('/hooks/outbox', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body, req.headers, process.env.OUTBOX_WEBHOOK_SECRET!);
    if (event.type === 'message.bounced') await markUndeliverable(event.data.to, event.data.metadata);
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.sendStatus(400);
    throw e;
  }
});
```

Signatures follow Standard Webhooks; timestamps older than 5 minutes are rejected.

## Options

```ts
new Outbox({
  apiKey: '…',          // default: process.env.OUTBOX_API_KEY
  baseUrl: '…',         // default: process.env.OUTBOX_BASE_URL, then https://outboxstack.app
  timeoutMs: 10_000,    // per attempt
  maxRetries: 2,
  fetch: customFetch,
});
```

Every method also accepts `{ signal }` (an `AbortSignal`) to cancel the request and any pending retries.

Use a **sending** API key (the dashboard default) in apps that only send: it can't change your workspace, and can be locked to one sender domain. Keep API keys on the server. Never ship them in browser or mobile bundles. Escape untrusted values before putting them in `html`.

## Development and releases

```sh
npm ci
npm test
npm pack --dry-run
```

Source: `src/index.ts`. Build outputs ESM, CommonJS, declarations and source maps to `dist/`. To release, bump `version` in `package.json` and push to main: `.github/workflows/publish.yml` publishes any version npm does not have yet, using npm trusted publishing.
