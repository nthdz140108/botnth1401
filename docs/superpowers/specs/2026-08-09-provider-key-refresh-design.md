# Provider Key Refresh Design

## Scope

Refresh provider credentials in the nested application root:
`HHH_MYBOT-V3MYBOTQRLOGIN-main/.env.local`.

The existing `.env.local` values are user-managed and must be preserved. The
source loads `.env.local` before `.env` with `override: false`, so missing
provider values can be added without replacing existing process or local
configuration.

## Behavior

Each supplied credential is checked with a low-cost, read-only request where a
stable validation endpoint exists. Results are classified as:

- `live`: authentication succeeds and the response is usable.
- `dead`: the provider explicitly rejects the credential or the credential is
  structurally invalid.
- `uncertain`: the provider is unavailable, rate-limited, or has no reliable
  validation endpoint.
- `unsupported`: the application has no consumer or configuration slot for the
  credential.

Only `live` credentials whose names are already supported by the application
are added when absent. Existing values are not overwritten, even when the
replacement source key is live. Dead values are removed only if they are
already present in `.env.local`; absent dead values are not added.

## Supported Surface

The application provider allowlist currently covers Gemini, SimSimi,
OpenWeather, WeatherAPI, Tomorrow.io, HoangDev, TikTok cookie, Spotify,
Spotify downloader secrets, Tenor, remove.bg, and ZingMP3. Legacy keys such as
SoundCloud, Imgur, Instagram, FM_X, and Zalo dirty-content are not added unless
the source already consumes them.

`.env.example` remains secret-free and is updated only if the supported key
names need documentation changes.

## Verification

After the refresh, run the provider/config tests and a focused scan confirming
that supplied secret literals are absent from source code and test output. Do
not print secret values or include them in the final report.
