# Dashboard Workspaces Phases 5-7

## Scope

Complete the dashboard redesign after the existing Overview workspace. The
dashboard remains a plain JavaScript and Express application. Bot core,
authentication, database, audit behavior, and files under `assets/` remain
outside scope.

## Architecture

`app.js` remains the browser compatibility bridge and owns legacy browser
globals. Five workspace modules own initialization of existing operational
sections: Bot Fleet, Automation, Messaging, Groups and Security, and System.
Modules receive a small context containing only the existing initializer
functions they invoke. Route aliases continue to point to the original page
sections, so endpoint and DOM contracts are preserved.

## Phase 5

The workspaces are `bots.js`, `automation.js`, `messaging.js`,
`groups-security.js`, and `system.js`. Each exports one `init...Workspace`
function and calls its assigned legacy initializer only when that function is
available. `dashboard-bootstrap.js` imports them and initializes each once.

## Phase 6

All dashboard source copy is valid UTF-8 Vietnamese. `UI_COPY` is absent.
Shared overlays provide focus restoration and keyboard escape behavior; toast
feedback remains an `aria-live` status. Credentials are masked until a user
explicitly chooses to reveal values.

## Phase 7

Node/JSDOM coverage verifies workspace registration, old hash compatibility,
loading/error/empty behavior, and overlay keyboard behavior. Browser coverage
runs at 1280x720, 1440x900, and 1920x1080, checking visible Overview output,
nonblank chart canvas, no horizontal overflow, and keyboard focus. UTF-8 and
full dashboard test commands provide completion evidence.
