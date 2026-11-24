# Group Bot Interaction Design

## Goal

Make `bot on` and `bot off` control bot interaction independently for each group.

## Behavior

- `bot on` enables normal member command and chat interaction for the current group.
- `bot off` disables normal member interaction for the current group.
- Global bot admins and bot admins stored for the current group can continue using commands while the group is off.
- The state is stored in the current group's `groupSettings[threadId].activeBot` value and does not affect other groups.
- Private-message behavior remains unchanged.

## Design

`handleCommand` will apply a group interaction gate after parsing the command and before cooldown, permission, or dispatch work. The gate allows a message when `activeBot === true` or `isAdminBot === true`. Existing command permission metadata remains responsible for controlling who can change the state with `bot on/off`.

The existing `isChangeSetting` and `writeGroupSettings(groupSettings)` path remains the persistence boundary. A small pure policy helper will make the gate independently testable without importing the large command module.

## Tests

The policy tests cover enabled member access, disabled member denial, disabled bot-admin access, and isolation between two group settings objects.
