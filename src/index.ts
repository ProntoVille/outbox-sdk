export const VERSION = '0.3.0';

/** `ada@example.com` or `Ada Obi <ada@example.com>`. */
export type Address = string;

export interface Attachment {
  filename: string;
  /** Base64 string, or raw bytes (Uint8Array / Buffer) which the SDK encodes. */
  content: string | Uint8Array;
  /** Inferred from the filename when omitted. */
  contentType?: string;
  /** Makes the file inline; reference it in html as `cid:<contentId>`. */
  contentId?: string;
}

export interface Message {
  /** One address or a list. Every address in to, cc and bcc gets its own message id; at most 50 in total. */
  to: Address | Address[];
  /** Display name when `to` is a single bare address. */
  toName?: string;
  cc?: Address | Address[];
  /** Never shown in any recipient's headers. */
  bcc?: Address | Address[];
  from: string;
  fromName?: string;
  /** Where replies go when it differs from `from`, e.g. a support inbox. */
  replyTo?: string;
  subject?: string;
  html?: string;
  text?: string;
  /** Template id or slug; `subject`/`html`/`text` come from the template. */
  template?: string;
  data?: Record<string, unknown>;
  /** Up to 20 custom headers. Routing, authentication and provider-control headers are refused. */
  headers?: Record<string, string>;
  /** Up to 10 files, 10 MB in total. */
  attachments?: Attachment[];
  /** Up to 10 string values of your own, returned by getMessage() and in webhooks. */
  metadata?: Record<string, string>;
}
export interface BatchMessage extends Message { idempotencyKey?: string; }

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'cancelled';
export interface RecipientResult { email: string; id: string; status: MessageStatus; duplicate: boolean; }
export interface SendResult {
  /** The first recipient's message id. */
  id: string;
  status: MessageStatus;
  /** True when the idempotency key matched an earlier send. */
  duplicate: boolean;
  /** One entry per recipient when the send had more than one. */
  recipients?: RecipientResult[];
}
export type BatchItemResult = { index: number; id: string; status: MessageStatus; duplicate: boolean; recipients?: RecipientResult[] } | { index: number; error: string; code: ErrorCode };
export interface BatchResult { accepted: number; failed: number; results: BatchItemResult[]; }
export interface MessageSummary { id: string; stream: 'transactional' | 'marketing'; to_email: string; subject: string; status: MessageStatus; created_at: string; }
export interface MessageDetail extends MessageSummary {
  from_email: string;
  from_name: string | null;
  to_name: string | null;
  reply_to: string | null;
  html: string | null;
  text: string | null;
  attempts: number;
  last_error: string | null;
  idempotency_key: string | null;
  provider_message_id: string | null;
  template_id: string | null;
  extras: { to?: string[]; cc?: string[]; headers?: Record<string, string>; attachments?: { filename: string; contentType: string; contentId?: string; size: number }[] } | null;
  metadata: Record<string, string> | null;
  updated_at: string;
  sent_at: string | null;
}
/** @deprecated Use MessageDetail. */
export type MessageResult = MessageDetail;

export interface RequestOptions { signal?: AbortSignal; }
export interface SendOptions extends RequestOptions {
  /** Same key → same message, even across retries and process restarts. 1–200 characters. Generated per call when omitted. */
  idempotencyKey?: string;
}
export interface OutboxOptions {
  /** Defaults to the OUTBOX_API_KEY environment variable. */
  apiKey?: string;
  /** Platform origin. Defaults to OUTBOX_BASE_URL, then https://outboxstack.app. */
  baseUrl?: string;
  /** Per attempt. Default 10000. */
  timeoutMs?: number;
  /** Retries after timeouts, network errors, 429 and 5xx. Default 2. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}
/** @deprecated Use OutboxOptions. */
export type MailClientOptions = OutboxOptions;

export class OutboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OutboxError';
  }
}
/** Stable error codes; branch on these rather than on the message text. New codes may appear. */
export type ErrorCode =
  | 'invalid_request' | 'invalid_address' | 'missing_content' | 'invalid_header' | 'invalid_metadata' | 'invalid_attachment' | 'too_many_recipients'
  | 'unauthorized' | 'forbidden' | 'sender_domain_not_allowed' | 'account_restricted'
  | 'payment_required' | 'quota_exceeded' | 'not_found' | 'template_not_found' | 'conflict' | 'payload_too_large'
  | 'unprocessable' | 'domain_not_verified' | 'invalid_sender' | 'missing_template_data' | 'sending_not_configured' | 'sending_unavailable'
  | 'sandbox_recipient_not_allowed' | 'unsupported_by_provider' | 'rate_limited' | 'sandbox_limit_reached'
  | 'internal_error' | 'unavailable' | (string & {});

/** The API answered with a non-2xx status. */
export class OutboxApiError extends OutboxError {
  status: number;
  code: ErrorCode;
  /** Quote this to support. */
  requestId: string | null;
  body: unknown;
  constructor(status: number, message: string, body: unknown = null, requestId: string | null = null) {
    super(message);
    this.name = 'OutboxApiError';
    this.status = status;
    this.body = body;
    const parsed = body as { code?: string; request_id?: string } | null;
    this.code = parsed?.code ?? 'error';
    this.requestId = parsed?.request_id ?? requestId;
  }
}

const DEFAULT_BASE_URL = 'https://outboxstack.app';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

function checkIdempotencyKey(key: unknown): void {
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) throw new OutboxError('idempotencyKey must contain 1–200 characters');
}

/**
 * Server-side Outbox client. Zero dependencies.
 * Requests that cannot cause a duplicate send are retried with backoff; see `maxRetries`.
 */
export class Outbox {
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #maxRetries: number;

  constructor({ apiKey = env('OUTBOX_API_KEY'), baseUrl = env('OUTBOX_BASE_URL') || DEFAULT_BASE_URL, fetch: fetcher = globalThis.fetch, timeoutMs = 10000, maxRetries = 2 }: OutboxOptions = {}) {
    if (!apiKey || typeof apiKey !== 'string') throw new OutboxError('An API key is required: pass apiKey or set OUTBOX_API_KEY');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new OutboxError('baseUrl must be the platform origin');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new OutboxError('Use HTTPS outside localhost');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new OutboxError('timeoutMs must be positive');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new OutboxError('maxRetries must be an integer from 0 to 10');
    if (typeof fetcher !== 'function') throw new OutboxError('No fetch implementation available; pass options.fetch');
    this.#apiKey = apiKey;
    this.#baseUrl = url.origin;
    this.#fetch = fetcher;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
  }

  /** Accepts a message into the queue. Accepted is not delivered: track it with getMessage() or webhooks. */
  send(message: Message, { idempotencyKey, signal }: SendOptions = {}): Promise<SendResult> {
    checkIdempotencyKey(idempotencyKey);
    return this.#request<SendResult>('POST', '/v1/messages', { body: encodeMessage(message), idempotencyKey: idempotencyKey ?? crypto.randomUUID(), retryable: true, signal });
  }

  /**
   * Sends up to 100 messages in one request. Items fail independently; check each result.
   * Retried only when every item carries an idempotencyKey.
   */
  sendBatch(messages: BatchMessage[], { signal }: RequestOptions = {}): Promise<BatchResult> {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) throw new OutboxError('sendBatch takes 1 to 100 messages');
    messages.forEach((m) => checkIdempotencyKey(m.idempotencyKey));
    const retryable = messages.every((m) => m.idempotencyKey !== undefined);
    return this.#request<BatchResult>('POST', '/v1/messages/batch', { body: { messages: messages.map(encodeMessage) }, retryable, signal });
  }

  getMessage(id: string, { signal }: RequestOptions = {}): Promise<MessageDetail> {
    if (!UUID.test(id)) throw new OutboxError('A message UUID is required');
    return this.#request<MessageDetail>('GET', '/v1/messages/' + id, { retryable: true, signal });
  }

  /** Most recent first. `limit` is 1–200 (default 50). */
  async listMessages({ status, limit, signal }: { status?: MessageStatus; limit?: number } & RequestOptions = {}): Promise<MessageSummary[]> {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (limit !== undefined) query.set('limit', String(limit));
    const path = '/v1/messages' + (query.size ? '?' + query : '');
    return (await this.#request<{ messages: MessageSummary[] }>('GET', path, { retryable: true, signal })).messages;
  }

  async #request<T>(method: string, path: string, { body, idempotencyKey, retryable, signal }: { body?: unknown; idempotencyKey?: string; retryable: boolean; signal?: AbortSignal }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json', 'user-agent': `outbox-node/${VERSION}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const canRetry = retryable && attempt < this.#maxRetries;
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        response = await this.#fetch(this.#baseUrl + path, { method, headers, body: payload, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (error) {
        if (signal?.aborted || !canRetry) throw error;
        await sleep(retryDelay(attempt), signal);
        continue;
      }
      const data = await response.json().catch(() => null);
      const requestId = response.headers.get('x-request-id');
      if (response.ok) {
        if (data === null) throw new OutboxApiError(response.status, 'Outbox API returned invalid JSON', null, requestId);
        return data as T;
      }
      if (canRetry && isRetryableStatus(response.status)) {
        await sleep(retryDelay(attempt, response.headers.get('retry-after')), signal);
        continue;
      }
      throw new OutboxApiError(response.status, (data as { error?: string } | null)?.error || `Outbox API returned HTTP ${response.status}`, data, requestId);
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function encodeMessage<T extends Message>(message: T): T {
  if (!message.attachments?.length) return message;
  return { ...message, attachments: message.attachments.map((a) => ({ ...a, content: typeof a.content === 'string' ? a.content : toBase64(a.content) })) };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After when the server gives one (capped at 30s), else exponential backoff with full jitter. */
function retryDelay(attempt: number, retryAfter?: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.random() * Math.min(500 * 2 ** attempt, 8_000);
}

export type WebhookEventType =
  | 'message.sent' | 'message.delivered' | 'message.bounced' | 'message.complained' | 'message.failed' | 'message.opened' | 'message.clicked'
  | 'contact.subscribed' | 'contact.unsubscribed';
export interface MessageEventData {
  message_id: string;
  to: string;
  subject: string;
  stream: 'transactional' | 'marketing';
  campaign_id: string | null;
  metadata: Record<string, string> | null;
  provider_message_id?: string;
  recipients?: string[];
  occurred_at?: string;
}
export interface ContactEventData { contact_id: string; email: string; list_id?: string; }
export type WebhookEvent =
  | { type: Exclude<WebhookEventType, 'contact.subscribed' | 'contact.unsubscribed'>; created_at: string; data: MessageEventData }
  | { type: 'contact.subscribed' | 'contact.unsubscribed'; created_at: string; data: ContactEventData };

export class WebhookVerificationError extends OutboxError {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Verifies a signed webhook (Standard Webhooks) and returns the parsed event.
 * Pass the raw request body exactly as received — not re-serialised JSON — and the request headers.
 * Throws WebhookVerificationError on a bad signature or a timestamp outside the tolerance (default 5 minutes).
 */
export async function verifyWebhook(payload: string | Uint8Array, headers: HeaderSource, secret: string, { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {}): Promise<WebhookEvent> {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(now / 1000 - sentAt) > toleranceSeconds) throw new WebhookVerificationError('Webhook timestamp is outside the allowed tolerance');
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  } catch {
    throw new WebhookVerificationError('Webhook secret is not valid base64');
  }
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const candidate of signatures.split(' ')) {
    const [version, encoded] = candidate.split(',');
    if (version !== 'v1' || !encoded) continue;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', cryptoKey, signature, signed)) {
      return JSON.parse(new TextDecoder().decode(body)) as WebhookEvent;
    }
  }
  throw new WebhookVerificationError('No matching webhook signature');
}

// Compatibility aliases for early local integrations.
export { Outbox as MailClient, OutboxApiError as MailApiError };
