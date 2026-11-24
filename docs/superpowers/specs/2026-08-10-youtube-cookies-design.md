# YouTube yt-dlp Cookies Design

## Goal

Allow the YouTube downloader to authenticate with user-provided cookies when YouTube returns a bot-verification error, without storing cookie data in the repository or exposing it in logs.

## Approach

Add a small helper that maps `YOUTUBE_COOKIES_FILE` to yt-dlp's `--cookies` option or `YOUTUBE_COOKIES_FROM_BROWSER` to `--cookies-from-browser`. An explicit cookie file takes precedence when both variables are set. An empty configuration keeps the current unauthenticated behavior.

Use the helper in both yt-dlp call sites: metadata extraction in `youtube-service.js` and media download in `youtube-download-worker.js`. The worker inherits the parent process environment, so no cookie value crosses the worker message payload.

## Error Handling

The helper only adds options for non-empty values. It does not read, parse, print, or validate cookie contents. Existing yt-dlp errors remain available to the existing error handling so an invalid or expired cookie produces a normal download failure.

## Testing

Add native `node:test` coverage for empty configuration, cookie-file configuration, browser configuration, and file-over-browser precedence. Add static integration assertions that both service and worker use the shared helper.

## Configuration Guidance

Document the two environment variables in `.env.example` and `README.md`. Recommend `YOUTUBE_COOKIES_FROM_BROWSER=chrome` or `edge` for local Windows use, and `YOUTUBE_COOKIES_FILE` for a Netscape-format export. Cookie files must remain local and must not be committed or pasted into chat/logs.
