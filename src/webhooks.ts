import { createHmac, timingSafeEqual } from 'node:crypto'
import { MyAdionError, SignatureVerificationError } from './errors.js'
import type { MyAdionEvent } from './types.js'

export const SIGNATURE_HEADER = 'Adion-Signature'
export const DEFAULT_TOLERANCE = 300

type Payload = string | Uint8Array

/**
 * Webhook events sent by Adion, signed in the `Adion-Signature` header:
 * `t=<unix time>,v1=<hex HMAC-SHA256 of "t.<raw body>">`.
 */
export class Webhooks {
  /**
   * Check the signature, then decode the event. Pass the raw body (a Buffer
   * or the exact string received), never a re-encoded JSON.
   *
   * @param tolerance maximum age of the signature in seconds (0 skips the check: never in production)
   * @throws SignatureVerificationError when the signature is missing, wrong or too old
   */
  constructEvent<T = Record<string, unknown>>(
    payload: Payload,
    header: string | string[] | undefined | null,
    secret: string,
    tolerance: number = DEFAULT_TOLERANCE,
  ): MyAdionEvent<T> {
    this.verifyHeader(payload, header, secret, tolerance)
    const body = toText(payload)
    let event: unknown
    try {
      event = JSON.parse(body)
    } catch (cause) {
      throw new MyAdionError('The webhook payload is not valid JSON.', { cause })
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new MyAdionError('The webhook payload is not a JSON object.')
    }
    return event as MyAdionEvent<T>
  }

  /** @throws SignatureVerificationError */
  verifyHeader(
    payload: Payload,
    header: string | string[] | undefined | null,
    secret: string,
    tolerance: number = DEFAULT_TOLERANCE,
    now: number = Math.floor(Date.now() / 1000),
  ): void {
    if (!secret) {
      throw new SignatureVerificationError('No webhook secret given: pass the whsec_… secret of the endpoint.')
    }
    const value = Array.isArray(header) ? header.join(',') : (header ?? '')
    if (value.trim() === '') {
      throw new SignatureVerificationError('No Adion-Signature header.')
    }

    let timestamp: number | undefined
    const signatures: string[] = []
    for (const part of value.split(',')) {
      const index = part.indexOf('=')
      if (index < 0) continue
      const key = part.slice(0, index).trim()
      const val = part.slice(index + 1).trim()
      if (key === 't' && /^\d+$/.test(val)) {
        timestamp = Number(val)
      } else if (key === 'v1' && val !== '') {
        signatures.push(val)
      }
    }
    if (timestamp === undefined) {
      throw new SignatureVerificationError('The Adion-Signature header has no timestamp.')
    }
    if (signatures.length === 0) {
      throw new SignatureVerificationError('The Adion-Signature header has no v1 signature.')
    }

    const expected = Buffer.from(this.computeSignature(timestamp, payload, secret), 'utf8')
    let match = false
    for (const signature of signatures) {
      const candidate = Buffer.from(signature, 'utf8')
      // Every candidate is compared, in constant time for a given length.
      match = (candidate.length === expected.length && timingSafeEqual(candidate, expected)) || match
    }
    if (!match) {
      throw new SignatureVerificationError('The signature does not match the payload. Check the secret and pass the raw body.')
    }
    if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
      throw new SignatureVerificationError('The signature timestamp is outside the tolerance zone (possible replay).')
    }
  }

  computeSignature(timestamp: number, payload: Payload, secret: string): string {
    const hmac = createHmac('sha256', secret).update(`${timestamp}.`, 'utf8')
    // The bytes as received: a Buffer is signed as is, never re-decoded.
    return (typeof payload === 'string' ? hmac.update(payload, 'utf8') : hmac.update(payload)).digest('hex')
  }

  /** A valid header for a payload, to test your webhook handler. */
  generateTestHeaderString(options: { payload: Payload; secret: string; timestamp?: number }): string {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    return `t=${timestamp},v1=${this.computeSignature(timestamp, options.payload, options.secret)}`
  }
}

function toText(payload: Payload): string {
  return typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')
}
