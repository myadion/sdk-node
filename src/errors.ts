/**
 * Every error thrown by the library extends MyAdionError.
 *
 * API errors carry the HTTP status, the machine-readable `code` returned by
 * the API (`validation_error`, `forbidden`…), the per-field `details`, the
 * response headers and the raw body.
 */
export interface MyAdionErrorInit {
  status?: number | undefined
  code?: string | undefined
  details?: Record<string, unknown> | undefined
  headers?: Record<string, string> | undefined
  rawBody?: string | undefined
  cause?: unknown
}

export class MyAdionError extends Error {
  /** The HTTP status, when the API answered. */
  readonly status: number | undefined
  /** The `error` field of the API response, e.g. `validation_error`. */
  readonly code: string | undefined
  /** The `details` field of the API response (the messages per field for a 422). */
  readonly details: Record<string, unknown>
  /** The response headers, lower-cased. */
  readonly headers: Record<string, string>
  /** The raw response body. */
  readonly rawBody: string | undefined

  constructor(message: string, init: MyAdionErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = new.target.name
    this.status = init.status
    this.code = init.code
    this.details = init.details ?? {}
    this.headers = init.headers ?? {}
    this.rawBody = init.rawBody
  }

  /** The `x-request-id` response header, when the API sends one. */
  get requestId(): string | undefined {
    return this.headers['x-request-id']
  }
}

/** 401: wrong client id or secret, revoked application, expired or revoked token. */
export class AuthenticationError extends MyAdionError {}

/** 403: a scope is missing, the project is outside the application, or the owner lost the right. */
export class PermissionError extends MyAdionError {}

/**
 * The request was refused as written: invalid parameters (400, 422), unknown
 * resource (404), conflict (409), insufficient credit (402)…
 */
export class InvalidRequestError extends MyAdionError {
  /** The messages per field: `{ success_url: ['…must be an https address.'] }`. */
  get errors(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [field, messages] of Object.entries(this.details)) {
      if (Array.isArray(messages)) {
        out[field] = messages.map((m) => String(m))
      } else if (typeof messages === 'string') {
        out[field] = [messages]
      }
    }
    return out
  }

  fieldErrors(field: string): string[] {
    return this.errors[field] ?? []
  }
}

/** 429: too many calls. The library already retried; slow down. */
export class RateLimitError extends MyAdionError {}

/** 5xx, or an answer the library cannot read. */
export class ApiError extends MyAdionError {}

/** The API could not be reached: DNS, TLS, timeout, connection reset. */
export class ApiConnectionError extends MyAdionError {}

/** A webhook signature is missing, malformed, wrong or too old. */
export class SignatureVerificationError extends MyAdionError {}
