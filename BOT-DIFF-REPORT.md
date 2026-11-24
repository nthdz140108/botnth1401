# Phase 0 Diff Report

Generated from the current HHH workspace and the Nqduan source snapshot.

## Summary

| Dataset | Raw commands | Unique commands | Duplicate removed | Current open gap |
| --- | ---: | ---: | --- | ---: |
| HHH command.json | 241 | 241 | none | 0 |
| Nqduan command.json | 216 | 215 | spamsms | 0 |

## Phase 0 Baseline

- HHH canonical manifest is aligned between `assets/json-data/command.json` and `mybot/defaultCommand.json` at 240 commands.
- The live command registry matches that manifest count.
- `mybot/migration/phase-0/command-baseline.json` captures that current manifest/registry state and is regenerated from the repo.
- Phase 0 snapshot is stored in `mybot/migration/phase-0/command-baseline.json`.
- VIP feature-flag defaults remain `vip.media`, `vip.ai`, `vip.group`, `vip.game`, `vip.utility`, and `vip.highRisk`.

## Nqduan Manifest Notes

- Raw Nqduan command entries: 216.
- Unique command names after deduplication: 215.
- Duplicate entry removed during normalization: spamsms.

## Current Open Gap

0 current open canonical gaps.

## Alias Bridges Already Covered In HHH

These Nqduan names are not counted as missing canonical HHH commands because HHH already exposes them under a different canonical command or alias:

- `addcmd` -> `alias`
- `cmdfind` -> `alias`
- `fixcmd` -> `alias`
- `removecmd` -> `alias`
- `acp` -> `alias`
- `rename` -> `name`
- `filegame` -> `sendresourcesfile`
- `invitebox` -> `group`
- `myaccount` -> `name`
- `setaccount` -> `name`
- `kiemtra` -> `group`
- `creategr` -> `group`
- `setavatarbox` -> `name`
- `blockmessage` -> `block`
- `unblockmessage` -> `unblockbot`
- `setavataraccount` -> `name`
- `mysetting` -> `name`
- `share` -> `sendresourcesfile`
- `setmute` -> `whitelist`
- `clean` -> `mybot`

The older 73-entry list only contained the first 19 mappings above; `share -> sendresourcesfile` is a newer bridge that exists in the current Nqduan manifest.

## Legacy 73-Entry Breakdown

The older diff report listed 73 Nqduan names. That historical list now decomposes into:

- 0 current open canonical gaps.
- 20 alias bridges that were already covered in the old report.
- 10 names that HHH now exposes as canonical commands.

The 19 historical alias bridges were:

- `addcmd` -> `alias`
- `cmdfind` -> `alias`
- `fixcmd` -> `alias`
- `removecmd` -> `alias`
- `acp` -> `alias`
- `rename` -> `name`
- `filegame` -> `sendresourcesfile`
- `invitebox` -> `group`
- `myaccount` -> `name`
- `setaccount` -> `name`
- `kiemtra` -> `group`
- `creategr` -> `group`
- `setavatarbox` -> `name`
- `blockmessage` -> `block`
- `unblockmessage` -> `unblockbot`
- `setavataraccount` -> `name`
- `mysetting` -> `name`
- `setmute` -> `whitelist`
- `clean` -> `mybot`

The 10 names already canonical in HHH are:

- `kickimg`
- `blockimg`
- `kickallmember`
- `leaveallbox`
- `dispersegroup`
- `blockallmember`
- `target`
- `key`
- `leavelock`
- `keylist`

