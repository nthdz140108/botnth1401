# Admin Recovery PM2-Visible Channel Design

## Context

The admin runtime now runs under the PM2 daemon. When the admin cookie becomes invalid, `src/index.js:recoverAdminWithQr()` starts `qr-login-admin.js` as a child of that background process. The recovery session exists, but its user interface is no longer visible in the interactive RDP desktop.

## Confirmed root cause

- `src/index.js` uses `stdio: "inherit"`, so the QR terminal output is inherited by PM2 and written to `%USERPROFILE%\.pm2\logs\admin-out.log`; it is not displayed in the foreground monitor window.
- `qr-login-admin.js` launches Puppeteer with `headless: false` and later tries a detached browser, but both remain descendants of the PM2 daemon. `windowsHide: false` does not move a process into the currently attached RDP desktop/session.
- The final `openPathInDefaultApp()` fallback explicitly uses `windowsHide: true`.
- Consequently, forcing another GUI spawn from the PM2 process is not a reliable Windows Server solution. PM2, Task Scheduler, services, and a later RDP login may all run in different window stations or sessions.

## Required behavior

1. Admin recovery must never depend on a GUI child appearing from PM2.
2. The QR producer writes one ephemeral, atomic recovery artifact under `.runtime/admin-recovery/`.
3. The authenticated dashboard detects an active recovery and automatically opens a modal containing the QR and expiry countdown.
4. Dashboard startup remains a control-plane action only: it reads the artifact and must not import `src/index.js`, log in to Zalo, or start/cancel recovery.
5. A foreground CLI can print the same QR as ASCII and optionally open it in the current interactive RDP session.
6. Direct manual execution of `qr-login-admin.js` may retain the current browser popup as a convenience, but PM2-managed execution skips GUI attempts after publishing the artifact.
7. The artifact contains no cookie, IMEI, token, QR scan result, or credentials. Only authenticated dashboard clients can fetch the QR image.
8. Success, failure, cancellation, replacement, and expiry remove the QR image and mark/clear the manifest idempotently.
9. The existing single recovery lock continues to own the QR child PID. This change must not create a second recovery session or a second `BOT LISTENER`.

## Artifact contract

`.runtime/admin-recovery/active.json`:

```json
{
  "schemaVersion": 1,
  "sessionId": "opaque-random-id",
  "state": "waiting_scan",
  "createdAt": "2026-08-31T00:00:00.000Z",
  "expiresAt": "2026-08-31T00:01:30.000Z",
  "qrFile": "sessions/opaque-random-id/qr.png",
  "ownerPid": 1234,
  "updatedAt": "2026-08-31T00:00:00.000Z"
}
```

Allowed states are `starting`, `waiting_scan`, `waiting_confirm`, `success`, `failed`, `cancelled`, and `expired`. `qrFile` is a relative path validated to remain inside `.runtime/admin-recovery`; the API never accepts a client-supplied path.

## Dashboard contract

- `GET /api/system/admin-recovery` returns sanitized metadata and, while active, `qrImage` as a `data:image/png;base64,...` value.
- The existing dashboard authentication middleware protects the route. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- The React client polls every two seconds only while authenticated. It opens once per new `sessionId`, updates the countdown, closes on terminal state, and does not mark the session handled on the server.

## Acceptance

- In a PM2-managed admin process, no Puppeteer/default-app launch is required for recovery to become visible.
- Opening the authenticated dashboard shows the QR within three seconds of publication.
- The CLI prints the same active QR from an RDP PowerShell window.
- Expired/replaced QR files cannot be fetched, and unauthenticated requests return 401.
- A real VPS recovery scan completes login, removes the artifact, opens port 2000, and leaves one admin PM2 process/listener.

