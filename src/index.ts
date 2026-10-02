export interface Message {
  to: string;
  from: string;
  fromName?: string;
  subject?: string;
  html?: string;
  text?: string;
  template?: string;
  data?: Record<string, unknown>;
}
export interface SendResult { id: string; status: string; }
export interface MessageResult extends SendResult {
  to_email: string;
  from_email: string;
  subject: string;
  attempts: number;
  last_error: string | null;
  events: Array<{ type: string; at: string }>;
}

export interface MailClientOptions { apiKey: string; baseUrl: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; }

/** Server-side transactional email client. No dependencies, no automatic send retries. */
export class OutboxApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'OutboxApiError';
    this.status = status;
  }
}

export class Outbox {
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  constructor({ apiKey, baseUrl, fetch: fetcher = globalThis.fetch, timeoutMs = 10000 }: MailClientOptions) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('An API key is required');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('baseUrl must be the platform origin');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS outside localhost');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    this.#apiKey = apiKey;
    this.#baseUrl = url.origin;
    this.#fetch = fetcher;
    this.#timeoutMs = timeoutMs;
  }
  async #request<T>(method: string, path: string, body?: Message, idempotencyKey?: string): Promise<T> {
    const response = await this.#fetch(this.#baseUrl + path, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.#apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new OutboxApiError(response.status, data?.error || `Email API returned HTTP ${response.status}`);
    if (!data) throw new OutboxApiError(response.status, 'Email API returned invalid JSON');
    return data as T;
  }
  send(message: Message, { idempotencyKey }: { idempotencyKey?: string } = {}): Promise<SendResult> {
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)) throw new Error('idempotencyKey must contain 1–200 characters');
    return this.#request<SendResult>('POST', '/v1/messages', message, idempotencyKey);
  }
  getMessage(id: string): Promise<MessageResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('A message UUID is required');
    return this.#request<MessageResult>('GET', '/v1/messages/' + encodeURIComponent(id));
  }
}

// Compatibility aliases for early local integrations.
export { Outbox as MailClient, OutboxApiError as MailApiError };
