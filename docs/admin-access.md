# Administrator access for self-hosted Molio

Molio has two access modes. `local` keeps the desktop and local development workflow. `server` requires a separate administrator session before mounting the management workspace or calling management APIs. The cloud email account and the site administrator account serve different purposes.

## Configuration

Server mode requires `MOLIO_ACCESS_MODE=server`, an HTTPS `MOLIO_PUBLIC_URL`, `MOLIO_ADMIN_USERNAME`, and `MOLIO_ADMIN_PASSWORD_HASH`. `MOLIO_HOST` controls the daemon listener. Invalid server configuration fails at startup rather than falling back to local mode. The Electron shell explicitly starts its own daemon in local mode.

Use `node scripts/setup-server.mjs --config .env` to initialize the configuration. See [server deployment](server-deployment.md) for Docker, HTTPS, backups and password recovery. Never commit `.env`, credential hashes or runtime data.

## Session boundary

- Anonymous callers may discover their session, submit a login and read the minimal health response. Management routes require authentication, including file downloads and event streams.
- Sessions use an HttpOnly, Secure, host-only cookie. Writes require both the configured Origin and the session CSRF token.
- Changing the configured administrator credentials revokes existing sessions. Restarting with unchanged credentials preserves unexpired sessions.
- The browser removes private UI and cancels tracked requests, streams and PDF loading when access is lost. Tabs recheck the server when notified of a session change.
- Stream interruptions expose a recovery action. A failed logout remains unconfirmed until the server can confirm the session state; it does not silently declare success.

## Upgrade considerations

Docker now defaults to server mode and binds the published port to host loopback. Existing self-hosted installations need administrator initialization and an HTTPS proxy before use. Set the public URL to the exact browser Origin, without a path prefix. Published images and hosted installer copies must be released separately from the source changes.

## Verification commands

```bash
pnpm build:contracts
pnpm typecheck
pnpm test
cd apps/web
npx playwright test
```

For the isolated production Web/daemon/HTTPS access suite, run `npx playwright test --config playwright.admin.config.ts` from `apps/web`. These tests create disposable data and credentials. Full E2E remains required for changes to the shared API client and chat lifecycle.
