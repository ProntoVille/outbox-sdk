export const VERSION = '0.2.0';

export interface Message {
  to: string;
  /** Recipient display name, shown as `"Ada Obi" <ada@example.com>`. */
  toName?: string;
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
}
export interface BatchMessage extends Message { idempotencyKey?: string; }

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'cancelled';
export interface SendResult { id: string; status: MessageStatus; /** True when the idempotency key matched an earlier message. */ duplicate?: boolean; }
export type BatchItemResult = { index: number; id: string; status: MessageStatus; duplicate: boolean } | { index: number; error: string };
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
/** The API answered with a non-2xx status. */
export class OutboxApiError extends OutboxError {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = 'OutboxApiError';
    this.status = status;
    this.body = body;
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
    return this.#request<SendResult>('POST', '/v1/messages', { body: message, idempotencyKey: idempotencyKey ?? crypto.randomUUID(), retryable: true, signal });
  }

  /**
   * Sends up to 100 messages in one request. Items fail independently; check each result.
   * Retried only when every item carries an idempotencyKey.
   */
  sendBatch(messages: BatchMessage[], { signal }: RequestOptions = {}): Promise<BatchResult> {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) throw new OutboxError('sendBatch takes 1 to 100 messages');
    messages.forEach((m) => checkIdempotencyKey(m.idempotencyKey));
    const retryable = messages.every((m) => m.idempotencyKey !== undefined);
    return this.#request<BatchResult>('POST', '/v1/messages/batch', { body: { messages }, retryable, signal });
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
      if (response.ok) {
        if (data === null) throw new OutboxApiError(response.status, 'Outbox API returned invalid JSON');
        return data as T;
      }
      if (canRetry && isRetryableStatus(response.status)) {
        await sleep(retryDelay(attempt, response.headers.get('retry-after')), signal);
        continue;
      }
      throw new OutboxApiError(response.status, (data as { error?: string } | null)?.error || `Outbox API returned HTTP ${response.status}`, data);
    }
  }
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

// Compatibility aliases for early local integrations.
export { Outbox as MailClient, OutboxApiError as MailApiError };
