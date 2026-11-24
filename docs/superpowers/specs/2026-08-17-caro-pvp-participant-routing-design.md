# Caro PvP participant routing

## Scope

Correct the Caro PvP game flow in a group without changing its board, turn, or rendering rules.

## Invitation and acceptance

Any member may challenge exactly one other member with the Caro command. The bot sends one invitation message that identifies the challenged member. A game starts only when that challenged member adds a heart reaction to that exact invitation message. A heart from the challenger, the bot account, or any other member does not start a game. This rule applies equally when the challenger is the bot account.

## Active-game message routing

An active game owns numeric moves and control words only from its two recorded players. Numeric messages from anyone else are ignored and produce no turn or validation message. Existing command routing remains unchanged for other bot commands.

## Surrender

Either recorded player may send `dauhang` or `dau hang` (with Vietnamese-accent equivalents accepted) while the game is active. The sender forfeits, the other player is announced as the winner, a final board is sent, and the game state and turn timer are removed. Non-participants cannot surrender or cancel someone else's game.

## Verification

Extend the Caro tests to cover: an outsider's numeric message being ignored; surrender by each player ending the game and awarding the opponent; the challenged member accepting an invite from a bot-account challenger; and hearts from all non-opponents being ignored.
