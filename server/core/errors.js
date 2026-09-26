// Normalised error model shared by every provider and route.
// The frontend maps `code` to a human message; `message` always carries the real cause.

export const ErrorCodes = {
  INVALID_REQUEST: { status: 400, retryable: false },
  INVALID_IMAGE: { status: 400, retryable: false },
  UNSUPPORTED_FORMAT: { status: 415, retryable: false },
  IMAGE_TOO_LARGE: { status: 413, retryable: false },
  PROMPT_TOO_LONG: { status: 400, retryable: false },
  UNSUPPORTED_OPTION: { status: 400, retryable: false },
  FORBIDDEN: { status: 401, retryable: false },
  NOT_CONFIGURED: { status: 503, retryable: false },
  AUTH_FAILED: { status: 502, retryable: false },
  INSUFFICIENT_CREDITS: { status: 402, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  QUOTA_EXCEEDED: { status: 429, retryable: false },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true },
  PROVIDER_ERROR: { status: 502, retryable: true },
  CONTENT_MODERATION: { status: 422, retryable: false },
  GENERATION_FAILED: { status: 422, retryable: true },
  NOT_FOUND: { status: 404, retryable: false },
  TIMEOUT: { status: 504, retryable: true },
  NETWORK: { status: 502, retryable: true },
  NOT_IMPLEMENTED: { status: 501, retryable: false },
  INTERNAL: { status: 500, retryable: true },
};

export class StudioError extends Error {
  constructor(code, message, { details, providerStatus, retryAfter } = {}) {
    super(message);
    this.name = 'StudioError';
    this.code = ErrorCodes[code] ? code : 'INTERNAL';
    this.status = ErrorCodes[this.code].status;
    this.retryable = ErrorCodes[this.code].retryable;
    this.details = details;
    this.providerStatus = providerStatus;
    this.retryAfter = retryAfter;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.providerStatus ? { providerStatus: this.providerStatus } : {}),
        ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function toStudioError(err) {
  if (err instanceof StudioError) return err;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new StudioError('TIMEOUT', 'The AI provider did not respond in time.');
  }
  if (err instanceof TypeError && /fetch|network|ECONN|ENOTFOUND|socket/i.test(String(err.message) + String(err.cause?.code || ''))) {
    return new StudioError('NETWORK', `Could not reach the AI provider (${err.cause?.code || err.message}).`);
  }
  return new StudioError('INTERNAL', err?.message || 'Unexpected server error.');
}
