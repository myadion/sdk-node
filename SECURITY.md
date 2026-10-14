# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **hello@myadion.com**, with "Security" in the subject, a description, the affected version and, if you can, the steps to reproduce. We acknowledge every report and keep you informed until it is fixed.

## Supported versions

Only the latest release receives security fixes.

## Good practice

- Keep the client secret and the webhook secret on your server, in environment variables or a secret manager. Never commit them, never send them to a browser or a mobile app.
- Give the application only the scopes it needs, and limit it to the projects it serves.
- Always verify webhook signatures with `MyAdion.webhooks.constructEvent()` on the raw body, and keep the default five-minute tolerance.
- If a secret leaks, revoke or rotate it at once in the customer area (application secret) or with `rotateSecret()` (webhook secret).
