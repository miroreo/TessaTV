/** Base class for failures a subtitle provider reports; adapters throw these, the service decides what to do. */
export class SubtitleProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Too many requests; try again after `retryAfterSeconds` when the provider said how long. */
export class RateLimitedError extends SubtitleProviderError {
  constructor(
    provider: string,
    readonly retryAfterSeconds: number | null,
    options?: { cause?: unknown },
  ) {
    super(provider, `${provider} rate limit hit`, options);
  }
}

/** The account's download allowance is used up; it resets at `resetsAt` when known. */
export class QuotaExhaustedError extends SubtitleProviderError {
  constructor(
    provider: string,
    readonly resetsAt: Date | null,
    options?: { cause?: unknown },
  ) {
    super(provider, `${provider} download quota exhausted`, options);
  }
}

/** Missing or rejected credentials: retrying won't help until an admin fixes them. */
export class AuthFailedError extends SubtitleProviderError {
  constructor(provider: string, options?: { cause?: unknown }) {
    super(provider, `${provider} rejected the credentials`, options);
  }
}
