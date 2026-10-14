# Changelog

All notable changes to `@myadion/sdk` are listed here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, a minor version may break compatibility.

## 0.3.0 - unreleased

- Adion Pay disputes: `PayPayment.dispute` (`PayDispute`: `status` `open`, `won`, `lost` or `closed`, `amount_cents`, `evidence_due_at`, `debited_cents`, `recredited_cents`). The disputed amount is debited from the Pay account when the dispute opens and credited back if it is won; `net_cents` accounts for it. A disputed payment can no longer be refunded (409).

## 0.2.0 - 2026-10-14

- Adion Pay embedded form: `ui_mode` (`hosted` or `embedded`) and `return_url` when creating a session; an embedded session comes back with its own `client_secret` and no `url`. Your page hands the `client_secret` to `https://pay.adioncloud.com/v1/adion-pay.js`. `PaySessionCreateParams` is now a union of `PayHostedSessionCreateParams` and `PayEmbeddedSessionCreateParams`.

## 0.1.0 - 2026-10-14

First release.

- `MyAdion` client: access token obtained and renewed automatically (`client_credentials`, one request shared by concurrent calls), `x-api-project` and `x-api-org` headers, retries with backoff on 429, 5xx, timeouts and network errors when safe, automatic `Idempotency-Key` on `POST /v1/pay/sessions`, per-attempt timeout, `AbortSignal` support.
- Adion Pay: sessions, payments, refunds, webhook endpoints and their deliveries.
- SMS: send and retrieve.
- `request()` and `requestCollection()` for every other route; lists are awaitable for one page and iterable with `for await` for all of them.
- `webhooks.constructEvent()`: signature checked in constant time, timestamp tolerance; also available as `MyAdion.webhooks`.
- Typed errors: `AuthenticationError`, `PermissionError`, `InvalidRequestError` (per-field errors), `RateLimitError`, `ApiError`, `ApiConnectionError`, `SignatureVerificationError`.
- TypeScript types, ES modules and CommonJS, no runtime dependency, Node.js 18+.
