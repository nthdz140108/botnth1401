# QR Prefix Restart Reliability

## Problem

Replying with a prefix for a QR-created bot writes the command configuration and then restarts the matched bot. The current adapter treats `killSpawnedProcess()` returning `false` as a hard restart failure. That return value also means the bot is already stopped or has no valid PID, so the launcher is never called for an already-dead bot.

## Design

Keep the change local to the QR prefix flow. Before killing, inspect the child process status. If the bot is not running, start it directly. If it is running, kill it; when kill reports failure, re-check status and only abort if the process is still alive. This preserves the existing `killSpawnedProcess()` contract for stop, delete, rollback, and periodic cleanup callers while making prefix restart idempotent.

The restart decision will live in a small dependency-injected helper so it can be tested without importing the full Zalo event module or starting a real child process. The event handler will provide the existing status, kill, and launcher functions.

## Behavior

- A stopped bot is started after its prefix is written.
- A running bot is stopped and then started.
- A kill race is tolerated when the process is gone on the follow-up status check.
- A running process that cannot be killed still returns the existing prefix restart error.
- Prefix persistence and reload behavior remain unchanged.

## Testing

Add focused tests for the stopped-bot path and the still-running kill-failure path. Keep the existing successful apply-then-restart test and run the complete Node test suite afterward.
