# vdsex yt-dlp Video Pool Design

## Goal

Keep the existing `vdsex` behavior of sending exactly one random video per command while expanding its candidate pool with sources resolved by `yt-dlp-exec`.

## Current behavior

- `vdsex` dispatches to `handleVideoCommand(api, message, "sex")`.
- The current `sex` variant reads direct video URLs from `src/service-debug/chat-zalo/chat-special/data-send/vdsex.txt`.
- A random URL is checked and sent with `api.sendVideo`.
- Failed direct URLs may be removed by the existing source handler.

## Proposed behavior

1. Keep `vdsex.txt` unchanged and continue treating its entries as direct video URLs.
2. Add `vdsex-ytdlp.txt` beside it for video-page URLs supported by yt-dlp.
3. On each `vdsex` invocation, load non-empty entries from both files and combine them into one candidate pool.
4. Select candidates randomly from the combined pool, so every line from either pool participates in the same selection process.
5. For a direct URL, use the existing validation and send path.
6. For a yt-dlp source, call `yt-dlp-exec` with a single-video MP4-compatible format, obtain a direct media URL, validate it, and send it through the existing `api.sendVideo` contract.
7. Send at most one video per command. If the selected source cannot be resolved, validated, or sent, try another unattempted candidate up to the existing retry limit.
8. Do not delete yt-dlp source entries after transient resolution failures. Preserve the source file as the user-maintained pool.
9. Keep the existing success caption, mention behavior, TTL, command name, permissions, countdown, and failure message.

## Data flow

```text
vdsex command
  -> load vdsex.txt + vdsex-ytdlp.txt
  -> combine and randomly select a source
  -> direct URL: validate -> api.sendVideo
  -> yt-dlp source: yt-dlp-exec -> direct URL -> validate -> api.sendVideo
  -> retry another source when the selected source fails
```

The implementation must pass a URL to `api.sendVideo`; it must not pass a local temporary file because the current Zalo API sends `videoUrl` as a remote URL and uses it for metadata/thumbnail processing.

## Error handling

- Missing `vdsex-ytdlp.txt` is treated as an empty new pool, preserving backward compatibility.
- Empty or whitespace-only lines are ignored.
- A yt-dlp command timeout, non-zero exit, empty output, invalid URL, or send failure marks only that attempt as failed.
- If all candidates fail, retain the current user-facing error message.
- yt-dlp subprocess errors are logged without exposing command arguments in the user-facing message.

## Testing

Add focused tests for:

- Combining direct and yt-dlp source entries into one pool.
- Selecting a source from either file.
- Passing direct URLs through without invoking yt-dlp.
- Resolving a yt-dlp source and sending its returned URL.
- Falling back to another candidate after resolution or send failure.
- Treating a missing new pool file as empty.

Tests should inject the yt-dlp resolver or command runner so they do not require network access or the yt-dlp binary during unit tests.

## Scope boundaries

- No change to command syntax or command registry.
- No background scheduler or persistent cache.
- No automatic scraping or addition of arbitrary online sources.
- The new pool contains only URLs explicitly placed in `vdsex-ytdlp.txt`.

