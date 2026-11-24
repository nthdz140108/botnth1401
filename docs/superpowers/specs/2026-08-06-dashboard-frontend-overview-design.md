# Dashboard Frontend and Overview Phases 3-4

## Scope

Deliver the frontend architecture and the Overview workspace described in the
dashboard redesign brief. This builds on the completed observability API and
does not modify bot core, the database, authentication, roles, audit trails,
or user data in `assets/`.

## Architecture

`dashboard/public/js/app.js` remains the small browser bootstrap and exposes
the legacy global operations (`startBot`, `stopBot`, and `deleteBot`). Focused
ES modules own routing, shared accessible UI behavior, and the Overview
workspace. The existing operational page markup and APIs remain available
through route aliases while the six top-level workspaces provide the new
navigation model.

The Overview workspace fetches `/api/dashboard/overview?range=24h|7d`, renders
the server contract into KPIs, health, fleet, activity, and a Chart.js traffic
chart, then applies incremental Socket.IO metrics and activity events. It shows
stale status after 45 seconds without a metrics event and can reload safely.

## Routing

The top-level workspaces are Overview, Bot Fleet, Automation, Messaging,
Groups and Security, and System. New routes are `#overview`, `#bots/fleet`,
`#automation/commands`, `#messaging/compose`, `#groups/settings`, and
`#system/credentials`; their documented subroutes are supported. Legacy hashes
map to the corresponding new route without breaking existing sections. Router
state preserves the active tab and filter values while navigating.

## User Interface

The dashboard uses dark-only cyber operations tokens: `#070A0D` page background,
`#0D1318` and `#121A21` surfaces, `#24313A` borders, `#F2F7FA` text,
`#93A4AF` muted text, and cyan, lime, amber, coral, and magenta status colors.
Cards use a 6-8px radius; data-dense areas prioritize readable tables and
forms. The desktop layout is supported from 1280px upward and honors reduced
motion preferences.

All async panels present loading, empty, and retryable error states. Toasts use
an aria-live region. Modals and drawers trap focus, restore focus on close, and
require confirmation for dangerous actions. `Ctrl/Cmd+K` opens a command palette
that finds workspaces, bots, and groups.

## Overview Workspace

KPIs show online and total bots, messages in the last 24 hours, active groups,
active commands, alerts in the last 24 hours, and uptime. Health reports CPU,
RAM, disk, and connection in text as well as status styling. The traffic chart
shows messages, alerts, and online bots across 24-hour and seven-day ranges.
Fleet rows put errored and offline bots first and open a detail drawer. Activity
contains only operational events and does not identify users.

## Verification

Tests cover every new and legacy route, workspace loading/error/empty states,
command palette keyboard use, focus behavior, destructive confirmation,
overview rendering, range changes, realtime updates, and stale metrics. The
UTF-8 checker and full Node test suite pass. Browser checks at 1280x720,
1440x900, and 1920x1080 show no overlap or overflow and a nonblank chart canvas.
