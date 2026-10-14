# Changelog

All notable changes to `@myadion/sdk` are listed here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, a minor version may break compatibility.

## 0.1.0 - 2026-10-14

First release.

- `MyAdion` client: access token obtained and renewed automatically (`client_credentials`, one request shared by concurrent calls), `x-api-project` and `x-api-org` headers, retries with backoff on 429, 5xx, timeouts and network errors when safe, automatic `Idempotency-Key` on `POST /v1/pay/sessions`, per-attempt timeout, `AbortSignal` support.
- Adion Pay: sessions, payments, refunds, webhook endpoints and their deliveries.
- SMS: send and retrieve.
- `request()` and `requestCollection()` for every other route; lists are awaitable for one page and iterable with `for await` for all of them.
- `webhooks.constructEvent()`: signature checked in constant time, timestamp tolerance; also available as `MyAdion.webhooks`.
- Typed errors: `AuthenticationError`, `PermissionError`, `InvalidRequestError` (per-field errors), `RateLimitError`, `ApiError`, `ApiConnectionError`, `SignatureVerificationError`.
- TypeScript types, ES modules and CommonJS, no runtime dependency, Node.js 18+.
