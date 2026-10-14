import { randomUUID } from 'node:crypto'
import {
  ApiConnectionError,
  ApiError,
  AuthenticationError,
  InvalidRequestError,
  MyAdionError,
  PermissionError,
  RateLimitError,
} from './errors.js'
import { Page, PagePromise } from './pagination.js'
import { PayResource } from './resources/pay.js'
import { SmsResource } from './resources/sms.js'
import type { LastResponse, MyAdionConfig, RequestOptions } from './types.js'
import { Webhooks } from './webhooks.js'
import { VERSION } from './version.js'

const DEFAULT_BASE_URL = 'https://adion-api.eu/api'

/** POST routes where the API honours `Idempotency-Key`: the library sets one and may retry them. */
const IDEMPOTENT_POSTS = [/^\/v1\/pay\/sessions$/]
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRY_DELAY = 8_000
const MAX_RETRY_AFTER = 60_000
/** A token is never sent in its last minute. */
const TOKEN_MARGIN = 60_000

const KNOWN_OPTIONS = new Set([
  'clientId', 'clientSecret', 'accessToken', 'scopes', 'project', 'organization', 'baseUrl',
  'timeout', 'maxRetries', 'retryBaseDelay', 'fetch', 'appInfo',
])

type Params = Record<string, unknown>

interface RawResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * The entry point of the library.
 *
 *     import { MyAdion } from '@myadion/sdk'
 *
 *     const myadion = new MyAdion({
 *       clientId: process.env.MYADION_CLIENT_ID,
 *       clientSecret: process.env.MYADION_CLIENT_SECRET,
 *     })
 *     const session = await myadion.pay.sessions.create({ … })
 *
 * The client exchanges its credentials for an access token on the first call
 * (`POST /auth/token`, client_credentials) and renews it before it expires.
 */
export class MyAdion {
  static readonly VERSION = VERSION
  static readonly DEFAULT_BASE_URL = DEFAULT_BASE_URL

  /** Adion Pay: sessions, payments, refunds, webhook endpoints. */
  readonly pay: PayResource
  /** Adion SMS: send and read text messages. */
  readonly sms: SmsResource
  /** Webhook signature verification. Needs no credentials. */
  readonly webhooks: Webhooks
  /** Same as `myadion.webhooks`, without a client: `MyAdion.webhooks.constructEvent(…)`. */
  static readonly webhooks = new Webhooks()

  /** The status and headers of the last answer (201 for a new session, 200 for one returned again). */
  lastResponse: LastResponse | undefined

  readonly #baseUrl: string
  readonly #clientId: string | undefined
  readonly #clientSecret: string | undefined
  readonly #staticToken: string | undefined
  readonly #scopes: string[]
  readonly #project: string | undefined
  readonly #organization: string | undefined
  readonly #timeout: number
  readonly #maxRetries: number
  readonly #retryBaseDelay: number
  readonly #fetch: typeof fetch
  readonly #userAgent: string
  #token: { value: string; expiresAt: number } | undefined
  #tokenRequest: Promise<string> | undefined

  constructor(config: MyAdionConfig = {}) {
    const unknown = Object.keys(config).filter((key) => !KNOWN_OPTIONS.has(key))
    if (unknown.length > 0) {
      throw new TypeError(`Unknown option(s) for MyAdion: ${unknown.join(', ')}.`)
    }
    this.#clientId = nonEmpty(config.clientId)
    this.#clientSecret = nonEmpty(config.clientSecret)
    this.#staticToken = nonEmpty(config.accessToken)
    if (this.#staticToken === undefined && (this.#clientId === undefined || this.#clientSecret === undefined)) {
      throw new TypeError('MyAdion needs clientId and clientSecret (or an accessToken).')
    }
    const scopes = config.scopes ?? []
    this.#scopes = typeof scopes === 'string' ? scopes.split(/[\s,]+/).filter(Boolean) : [...scopes]
    this.#project = nonEmpty(config.project)
    this.#organization = nonEmpty(config.organization)
    this.#baseUrl = (nonEmpty(config.baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#timeout = config.timeout ?? 30_000
    this.#maxRetries = Math.max(0, config.maxRetries ?? 2)
    this.#retryBaseDelay = Math.max(0, config.retryBaseDelay ?? 500)
    const fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch available: use Node 18 or later, or pass { fetch }.')
    }
    this.#fetch = fetchImpl
    let userAgent = `myadion-node/${VERSION} node/${process.versions.node}`
    if (config.appInfo) {
      const { name, version, url } = config.appInfo
      userAgent += ` ${name}${version ? `/${version}` : ''}${url ? ` (${url})` : ''}`
    }
    this.#userAgent = userAgent

    this.pay = new PayResource(this)
    this.sms = new SmsResource(this)
    this.webhooks = new Webhooks()
  }

  /**
   * Call any route of the API. `path` is relative to the base URL
   * (`/account/pay`, `/v1/sms/sms_msg_…`). `params` go in the query string
   * for GET and DELETE, in a JSON body otherwise.
   */
  async request<T = unknown>(method: string, path: string, params: Params = {}, options: RequestOptions = {}): Promise<T> {
    const response = await this.#send(method, path, params, options)
    return decode(response) as T
  }

  /**
   * Call a list route. Await it for the first page, or iterate it with
   * `for await` to walk every item.
   */
  requestCollection<T = unknown>(method: string, path: string, params: Params = {}, options: RequestOptions = {}): PagePromise<T> {
    const load = (page: number | undefined): Promise<Page<T>> => {
      const p = page === undefined ? params : { ...params, page }
      return this.request(method, path, p, options).then((decoded) => new Page<T>(decoded, p, (next) => load(next)))
    }
    return new PagePromise(() => load(undefined))
  }

  /** The current access token, fetched if needed. */
  async getAccessToken(): Promise<string> {
    if (this.#staticToken !== undefined) return this.#staticToken
    if (this.#token && this.#token.expiresAt - TOKEN_MARGIN > Date.now()) return this.#token.value
    // Concurrent calls share a single token request.
    this.#tokenRequest ??= this.#fetchToken().finally(() => {
      this.#tokenRequest = undefined
    })
    return this.#tokenRequest
  }

  async #fetchToken(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId ?? '',
      client_secret: this.#clientSecret ?? '',
    })
    if (this.#scopes.length > 0) form.set('scope', this.#scopes.join(' '))
    const response = await this.#attempts('POST', `${this.#baseUrl}/auth/token`, {
      ...this.#baseHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    }, form.toString(), true, this.#maxRetries, false, {})
    const decoded = decode(response) as { access_token?: unknown; expires_in?: unknown } | null
    const token = decoded?.access_token
    if (typeof token !== 'string' || token === '') {
      throw new ApiError('The token endpoint answered without access_token.', { status: response.status, headers: response.headers, rawBody: response.body })
    }
    const expiresIn = typeof decoded?.expires_in === 'number' ? decoded.expires_in : 3600
    this.#token = { value: token, expiresAt: Date.now() + expiresIn * 1000 }
    return token
  }

  #baseHeaders(): Record<string, string> {
    return { Accept: 'application/json', 'User-Agent': this.#userAgent }
  }

  async #send(method: string, path: string, params: Params, options: RequestOptions): Promise<RawResponse> {
    method = method.toUpperCase()
    path = '/' + path.replace(/^\/+/, '')
    const headers = this.#baseHeaders()

    const project = options.project === undefined ? this.#project : options.project
    if (project) headers['x-api-project'] = project
    const organization = options.organization === undefined ? this.#organization : options.organization
    if (organization) headers['x-api-org'] = organization

    let retryable = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)
    if (method === 'POST') {
      let key = options.idempotencyKey
      const route = path.split('?')[0] ?? path
      if (IDEMPOTENT_POSTS.some((pattern) => pattern.test(route))) {
        key ??= `myadion-node-${randomUUID()}`
        retryable = true
      }
      if (key) headers['Idempotency-Key'] = key
    }
    Object.assign(headers, options.headers ?? {})

    let url = this.#baseUrl + path
    let body: string | undefined
    if (['GET', 'HEAD', 'DELETE'].includes(method)) {
      const query = encodeQuery(params)
      if (query !== '') url += (url.includes('?') ? '&' : '?') + query
    } else {
      body = JSON.stringify(params)
      headers['Content-Type'] = 'application/json'
    }

    return this.#attempts(method, url, headers, body, retryable, options.maxRetries ?? this.#maxRetries, true, options)
  }

  async #attempts(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    retryable: boolean,
    maxRetries: number,
    authenticated: boolean,
    options: RequestOptions,
  ): Promise<RawResponse> {
    let attempt = 0
    let renewedToken = false
    for (;;) {
      if (authenticated) headers.Authorization = `Bearer ${await this.getAccessToken()}`

      let response: RawResponse
      try {
        response = await this.#fetchOnce(method, url, headers, body, options)
      } catch (error) {
        if (options.signal?.aborted) {
          throw new ApiConnectionError('The request was aborted.', { cause: error })
        }
        if (retryable && attempt < maxRetries) {
          await sleep(this.#delay(attempt, undefined))
          attempt++
          continue
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new ApiConnectionError(`Could not reach the Adion Cloud API: ${reason}`, { cause: error })
      }
      this.lastResponse = { status: response.status, headers: response.headers }

      // A managed token refused once (revoked, expired early): one new token, one new try.
      if (response.status === 401 && authenticated && this.#staticToken === undefined && !renewedToken) {
        renewedToken = true
        this.#token = undefined
        continue
      }

      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries && (retryable || response.status === 429)) {
        await sleep(this.#delay(attempt, response.headers['retry-after']))
        attempt++
        continue
      }

      if (response.status >= 400) throw toError(response)
      return response
    }
  }

  async #fetchOnce(method: string, url: string, headers: Record<string, string>, body: string | undefined, options: RequestOptions): Promise<RawResponse> {
    const controller = new AbortController()
    const timeout = options.timeout ?? this.#timeout
    const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeout} ms`)), timeout)
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.#fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' })
      const text = await res.text()
      const out: Record<string, string> = {}
      res.headers.forEach((value, name) => {
        out[name.toLowerCase()] = value
      })
      return { status: res.status, headers: out, body: text }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  #delay(attempt: number, retryAfter: string | undefined): number {
    if (retryAfter !== undefined && /^\d+(\.\d+)?$/.test(retryAfter.trim())) {
      return Math.min(Number(retryAfter) * 1000, MAX_RETRY_AFTER)
    }
    const delay = Math.min(this.#retryBaseDelay * 2 ** attempt, MAX_RETRY_DELAY)
    // Jitter: between half and all of the delay, so that clients do not retry in step.
    return delay * (0.5 + Math.random() / 2)
  }
}

function decode(response: RawResponse): unknown {
  const body = response.body.trim()
  if (body === '') return null
  try {
    return JSON.parse(body)
  } catch (cause) {
    throw new ApiError('The API answered something that is not JSON.', { status: response.status, headers: response.headers, rawBody: response.body, cause })
  }
}

function toError(response: RawResponse): MyAdionError {
  let message: string | undefined
  let code: string | undefined
  let details: Record<string, unknown> | undefined
  try {
    const decoded = JSON.parse(response.body) as Record<string, unknown>
    if (decoded && typeof decoded === 'object') {
      if (typeof decoded.message === 'string') message = decoded.message
      else if (typeof decoded.error_description === 'string') message = decoded.error_description
      if (typeof decoded.error === 'string') code = decoded.error
      if (decoded.details && typeof decoded.details === 'object') details = decoded.details as Record<string, unknown>
    }
  } catch {
    // not JSON: the status speaks for itself
  }
  const init = { status: response.status, code, details, headers: response.headers, rawBody: response.body }
  const text = message ?? `The API answered HTTP ${response.status}.`
  if (response.status === 401) return new AuthenticationError(text, init)
  if (response.status === 403) return new PermissionError(text, init)
  if (response.status === 429) return new RateLimitError(text, init)
  if (response.status >= 500) return new ApiError(text, init)
  return new InvalidRequestError(text, init)
}

/** `page=2&status=succeeded`, booleans as 1/0, arrays as `key[]=`. */
export function encodeQuery(params: Params): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) query.append(`${key}[]`, String(item))
    } else if (typeof value === 'boolean') {
      query.append(key, value ? '1' : '0')
    } else {
      query.append(key, String(value))
    }
  }
  return query.toString()
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
