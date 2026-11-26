# Remove the November 25 portal and dashboard upgrade

The user requested removal of the rental website and recent admin dashboard changes, followed by a push for the existing BAT updater.

1. Revert portal b929f18 and dashboard V5 0865204. Preserve command overhaul 4bdbd37 and generic deployment fixes from a0895cf/6500fbd.
2. Keep the V4 dashboard, matching dependency lockfile, and current release asset selection.
3. Allow deletion of the three retired portal migration source files only when the target no longer contains portal source. Never run SQL or delete database/runtime data.
4. Use commit-addressed deployment control to avoid running the previous worker's portal build logic during removal.
5. Remove copied portal build artifacts; disable existing portal services after switching. Restore their services if transaction recovery restores the previous release.
6. Verify retirement, deployment regression tests, dashboard build, and the dry-run from the actual VPS baseline before pushing main and codex/locmem-recovery. Deployment remains the user's BAT action.
