# QR Login Expiry Design

## Goal

Stop both QR login flows when the QR session expires. A timed-out or explicitly expired session must not continue waiting, must not write credentials, and must release the active-login lock.

## Scope

- Chat command flow in `src/commands/mybot/Credentials/qr-login.js` and `src/commands/mybot/Manager/qr-login-command.js`.
- Dashboard/API flow in `src/dashboard/qr-session.js`.
- Existing cancellation and success behavior remains unchanged.

## Design

Each flow owns a deadline for the QR session and an `AbortController` for in-flight polling.

The command flow passes the abort signal through `waitingScan` and `waitingConfirm`. Those polling loops stop on abort, their configured deadline, or an explicit QR-expired response from Zalo. The command handler treats expiry as a dedicated failure reason, sends an expiry message, and relies on its existing cleanup path to remove the QR image and active session lock.

The dashboard manager stores the controller with each active entry. Its scan and confirmation waits are bounded by the same session deadline. On timeout it aborts the controller, marks the entry `expired`, removes private session/code data, and prevents late results from writing credentials. `cancel()` uses the same abort path and remains `cancelled` rather than `expired`.

## Error Handling

- Expiry is distinguishable from a generic failed login.
- Cancellation and expiry are terminal states.
- A late scan/confirmation result is ignored when the entry is no longer active or the deadline has passed.
- Credential writes only occur after a successful, non-expired confirmation.
- QR files and active-session locks are cleaned in `finally` paths.

## Testing

- Command polling returns an expiry result when the deadline is reached or the abort signal fires.
- Dashboard sessions become `expired` at the deadline, abort pending work, and never write credentials.
- A successful QR flow still reaches `configured` and writes credentials once.
- Explicit cancellation still reaches `cancelled` and blocks late results.
- Existing QR login and project tests continue to pass.
