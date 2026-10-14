/**
 * One page of a list. The API paginates with `page` and `per_page` and
 * answers `{ data, meta: { current_page, last_page, per_page, total } }`
 * (or a bare list, a single page).
 */
export class Page<T> {
  readonly data: T[]
  readonly currentPage: number
  readonly lastPage: number | undefined
  readonly perPage: number | undefined
  readonly total: number | undefined
  /** The full answer, for the fields next to the list (`event_types`…). */
  readonly raw: Record<string, unknown>
  readonly #fetchPage: ((page: number) => Promise<Page<T>>) | undefined
  readonly #hasMore: boolean

  constructor(decoded: unknown, params: Record<string, unknown>, fetchPage?: (page: number) => Promise<Page<T>>) {
    this.#fetchPage = fetchPage
    if (Array.isArray(decoded)) {
      this.data = decoded as T[]
      this.raw = {}
      this.currentPage = 1
      this.lastPage = 1
      this.perPage = undefined
      this.total = decoded.length
      this.#hasMore = false
      return
    }
    const body = (decoded !== null && typeof decoded === 'object' ? decoded : {}) as Record<string, unknown>
    const meta = (body.meta !== null && typeof body.meta === 'object' ? body.meta : body) as Record<string, unknown>
    this.raw = body
    this.data = Array.isArray(body.data) ? (body.data as T[]) : []
    const current = toInt(meta.current_page)
    const last = toInt(meta.last_page)
    this.perPage = toInt(meta.per_page)
    this.total = toInt(meta.total)
    this.lastPage = last
    if (current !== undefined && last !== undefined) {
      this.currentPage = current
      this.#hasMore = current < last
    } else {
      this.currentPage = toInt(params.page) ?? 1
      this.#hasMore = body.has_more === true
    }
  }

  get hasMore(): boolean {
    return this.#hasMore && this.#fetchPage !== undefined && this.data.length > 0
  }

  /** The next page, or null on the last one. */
  async nextPage(): Promise<Page<T> | null> {
    if (!this.hasMore || this.#fetchPage === undefined) {
      return null
    }
    return this.#fetchPage(this.currentPage + 1)
  }

  /** Every item of this page and of the following ones, fetched lazily. */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the walk starts from this page
    let page: Page<T> | null = this
    while (page !== null) {
      for (const item of page.data) {
        yield item
      }
      page = await page.nextPage()
    }
  }
}

/**
 * What a list method returns: await it for the first page, or iterate it
 * with `for await` to walk every item of every page.
 *
 *     const page = await myadion.pay.payments.list({ per_page: 50 })
 *     for await (const payment of myadion.pay.payments.list()) { … }
 */
export class PagePromise<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  readonly #load: () => Promise<Page<T>>
  #promise: Promise<Page<T>> | undefined

  constructor(load: () => Promise<Page<T>>) {
    this.#load = load
  }

  #page(): Promise<Page<T>> {
    this.#promise ??= this.#load()
    return this.#promise
  }

  then<R1 = Page<T>, R2 = never>(
    onfulfilled?: ((value: Page<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#page().then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<Page<T> | R> {
    return this.#page().catch(onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    yield* await this.#page()
  }

  /** Every item, up to `limit` (10 000 by default, to protect your memory). */
  async toArray(options: { limit?: number } = {}): Promise<T[]> {
    const limit = options.limit ?? 10_000
    const out: T[] = []
    for await (const item of this) {
      if (out.length >= limit) break
      out.push(item)
    }
    return out
  }
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}
