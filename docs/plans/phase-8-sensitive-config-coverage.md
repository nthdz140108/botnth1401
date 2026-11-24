# Phase 8 Sensitive Config Coverage

Scope: Zalo runtime configuration moved through HHH config adapter boundaries without recording live secrets.

## Covered Mappings

| Item | Status | Notes |
|---|---|---|
| `ZALO_WEB_URL` | mapped | Read by `src/api-zalo/zalo-config.js` and surfaced in provider config health. |
| `ZALO_ORIGIN` | mapped | Used for Zalo request origin headers. |
| `ZALO_REFERER` | mapped | Used for Zalo request referer headers. |
| `ZALO_USER_AGENT` | mapped | Used for Zalo login/session headers and QR identity generation. |
| `cookie` payload URL for Zalo QR login | mapped | Centralized through `getZaloCookiePayload()`. |

## Verification

- `tests/provider-config.test.js` covers safe overrides for Zalo runtime config.
- `src/dashboard/provider-config-service.js` includes Zalo runtime keys in provider config summaries.
- `qr-login-admin.js`, `src/api-zalo/utils.js`, `src/api-zalo/apis/listen.js`, and `src/commands/mybot/Credentials/qr-login.js` now read through the adapter instead of hardcoding the runtime values directly.

## Redaction Rule

This report intentionally avoids raw secret values, sample cookies, or live session data.
