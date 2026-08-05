/**
 * The one place Panorama talks to the network.
 *
 * Every registry has its own etiquette and we honour all of it here rather than
 * scattering headers and sleeps across seven providers:
 *   - crates.io requires a descriptive User-Agent and caps clients at 1 req/sec.
 *   - Packagist asks that the User-Agent carry a contact address.
 *   - Everyone benefits from ETag revalidation and backoff on 429/5xx.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Requests per second, per host. Absent means "no explicit limit". */
const RATE_LIMITS: Record<string, number> = {
  'crates.io': 1,
  'api.osv.dev': 10,
  'api.deps.dev': 10,
  'search.maven.org': 5,
  'packagist.org': 5,
  'repo.packagist.org': 5,
};

export interface HttpOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Skip the ETag cache for this request. */
  noCache?: boolean;
  timeoutMs?: number;
}

interface CachedEntry {
  etag?: string;
  lastModified?: string;
  body: string;
}

/**
 * A token bucket that releases one slot per interval. Requests queue rather
 * than fail, so a 200-crate project degrades to "slow" instead of "rate limited".
 */
class HostLimiter {
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    next();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, this.intervalMs);
  }
}

export class HttpClient {
  private readonly limiters = new Map<string, HostLimiter>();
  private readonly etagCache = new Map<string, CachedEntry>();
  private userAgent: string;

  constructor(extensionVersion: string, contactEmail?: string) {
    this.userAgent = buildUserAgent(extensionVersion, contactEmail);
  }

  /** Rebuilds the User-Agent after the user edits `panorama.contactEmail`. */
  setContactEmail(extensionVersion: string, contactEmail?: string): void {
    this.userAgent = buildUserAgent(extensionVersion, contactEmail);
  }

  async getJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
    const text = await this.request(url, options);
    return JSON.parse(text) as T;
  }

  async postJson<T>(url: string, body: unknown, options: HttpOptions = {}): Promise<T> {
    const text = await this.request(url, { ...options, method: 'POST', body, noCache: true });
    return JSON.parse(text) as T;
  }

  async getText(url: string, options: HttpOptions = {}): Promise<string> {
    return this.request(url, options);
  }

  private async request(url: string, options: HttpOptions): Promise<string> {
    const host = new URL(url).host;
    const limit = RATE_LIMITS[host];
    if (limit !== undefined) {
      let limiter = this.limiters.get(host);
      if (!limiter) {
        limiter = new HostLimiter(limit);
        this.limiters.set(host, limiter);
      }
      await limiter.acquire();
    }

    return this.attempt(url, options, 0);
  }

  private async attempt(url: string, options: HttpOptions, retryCount: number): Promise<string> {
    const cached = options.noCache ? undefined : this.etagCache.get(url);

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      ...options.headers,
    };
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }
    if (cached?.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Combine the caller's cancellation with our own timeout so a hung registry
    // can never wedge a scan.
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? anySignal([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });

      // 304 means our cached copy is still good.
      if (response.status === 304 && cached) {
        return cached.body;
      }

      if (response.status === 429 || response.status >= 500) {
        if (retryCount < 3) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** retryCount * 500;
          await sleep(delayMs, options.signal);
          return this.attempt(url, options, retryCount + 1);
        }
      }

      if (!response.ok) {
        throw new HttpError(`${response.status} ${response.statusText}`, response.status, url);
      }

      const body = await response.text();

      if (!options.noCache) {
        const etag = response.headers.get('etag') ?? undefined;
        const lastModified = response.headers.get('last-modified') ?? undefined;
        if (etag || lastModified) {
          this.etagCache.set(url, { etag, lastModified, body });
        }
      }

      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** A missing package is an expected outcome, not a failure worth surfacing. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function buildUserAgent(version: string, contactEmail?: string): string {
  const contact = contactEmail?.trim()
    ? `; mailto=${contactEmail.trim()}`
    : '';
  return `Panorama-VSCode/${version} (+https://github.com/salvatorecorvaglia/panorama${contact})`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Node 20 has `AbortSignal.any`, but we keep a fallback for older hosts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
