# Bot Off Group Interaction Design

## Goal

Keep the bot listener active for event ingestion and logging, while preventing all automatic group interaction when a group has been switched off with `bot off`.

## Root Cause

`messagesUser` correctly uses `activeBot` before chat/game reply handling, but it always calls `handleChatBot` afterward. `handleChatBot` only checks `replyEnabled`, so a group with `activeBot: false` can still receive learned or configured auto-replies.

## Design

Add a small `isGroupBotActive` policy helper and use it for an early return in `handleChatBot` when `groupSettings[threadId].activeBot` is not `true`. This keeps the event listener, logging, and command dispatch intact. The `bot` command is dispatched before this helper is called, so administrators can still issue `bot on` while the group is off.

The guard also prevents the learning branch from mutating training data while the bot is off. Existing `replyEnabled` behavior remains unchanged while `activeBot` is true.

## Testing

Add focused Node tests for the pure group-active policy, covering both `activeBot: false` and `activeBot: true`. The production guard consumes the same policy helper, while the test avoids importing the runtime-heavy chatbot module.

## Scope

No changes to listener registration, `canProcessChat`, `handleCommand`, group-wide `groupEnabled`, command permissions, or private-message behavior.
