# Reply Workflow Access Design

## Goal

Allow any group member to reply to and continue a multi-step workflow started by a command whose command permission is `all`. Keep workflows that perform administrative actions restricted to the user who started them.

## Root Cause

Group reply dispatch is currently coupled to chat eligibility after command handling. The event handler sets `handleChat` to `false` for ordinary users when the bot's active-chat path requires `isSelf`, then only calls `handleOnReplyFromUser` when `handleChat || isAdminBot`. As a result, ordinary-user replies never reach the reply handlers, while bot admins bypass that gate.

The public selection handlers also reject a reply when its sender differs from the stored requester. Fixing only dispatch would therefore still reject an admin or another member after a normal user starts a public command.

## Design

1. Preserve the pre-command message eligibility in a separate `canProcessReply` value. Dispatch reply handling for every eligible plain-text group message, independently of the later chatbot eligibility flag. Treat a reply as handled without turning on unrelated chatbot behavior.
2. Add a small `reply-access` policy helper. Reply state marked `public` accepts any sender in the same `threadId`; state without that marker remains owner-only.
3. Mark selection state created by public media/search workflows as `public`: SoundCloud, Zing MP3, NhacCuaTui, YouTube, TikTok, both download implementations, Spotify, CapCut, and XNXX.
4. Leave `scan-group` and `remote-action-group` requester checks unchanged because their follow-up replies can kick/block members or execute commands in another group.

## Error Handling

An unmatched quote still returns `false` so the existing chat pipeline can continue. Invalid selections keep the existing warning response. Public state from another group is rejected. Admin-only workflow state remains owner-bound and continues to ignore other senders.

## Testing

Add focused tests for the policy helper: public state accepts a different sender, owner-only state accepts only its requester, and admin/action state cannot be opened by another sender. Add a source-level contract test for the group event flow proving reply dispatch uses the pre-command eligibility instead of the post-command `handleChat` value. Run the focused tests and then the full Node test suite.
