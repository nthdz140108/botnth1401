# V4 Spec — Response Envelope (byte-for-byte parity with MyBot V3)

**Source of truth:** `C:\Users\AD\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main` @ commit `3650ff7`
("fix(all): resolve 7-cluster runtime, mybot, anti-service, command, and dashboard issues to 100% pass").

**Purpose:** let a Rust rewrite reproduce V3 message envelopes *byte-for-byte*. Every claim below cites
`file:line` against the V3 tree. Where the current Rust port already exists, the target files are
`rust/crates/mybot-core/src/v3_style.rs` and `rust/crates/mybot-core/src/pipeline.rs`.

> **Disk-name reconciliation (task asked me to check current names first).**
> - `src/service-debug/chat-zalo/chat-style/chat-style.js` — exists, and is the **only** file in
>   `chat-style/` (no siblings). It is a thin façade: every export delegates to
>   `src/commands/mybot/System/mybot-style.js`.
> - `src/commands/command-response.js` — exists (70 lines).
> - `src/commands/command.js` — exists and still owns the dispatcher (`handleCommand`,
>   `handleCommandPrivate`). There is **no** `command-response-builder.js`; the response builders live in
>   `chat-style.js` + `mybot-style.js`.
> - Additional load-bearing files not named in the task but required for parity:
>   `src/utils/interaction-countdown.js`, `src/utils/role-policy.js`,
>   `src/commands/bot-manager/utilities.js`, `src/utils/format-util.js`,
>   `src/api-zalo/models/Message.js`, `src/api-zalo/models/Reaction.js`, `src/api-zalo/apis/sendMessage.js`,
>   `src/api-zalo/apis/addReaction.js`.

---

## 0. Ground constants

| Constant | Value | Cite |
| --- | --- | --- |
| `COLOR_RED` | `"db342e"` | `src/service-debug/chat-zalo/chat-style/chat-style.js:11` |
| `COLOR_YELLOW` | `"f7b503"` | `chat-style.js:12` |
| `COLOR_GREEN` | `"15a85f"` | `chat-style.js:13` |
| `SIZE_18` | `"18"` | `chat-style.js:14` |
| `SIZE_16` | **`"14"`** ← the name lies | `chat-style.js:15` |
| `IS_BOLD` | `true` | `chat-style.js:16` |
| `fallbackNameServer` | `"Thanh Hung"` | `chat-style.js:4` |
| `SIZE_MIN` / `SIZE_MAX` | `10` / `24` | `mybot-style.js:36-37` |
| Default TTL in builder | `60000` | `mybot-style.js:180` |
| `MAX_REACTION_BATCH_SIZE` | `50` | `src/utils/interaction-countdown.js:316` |
| `QR_LOGIN_TIMEOUT_MS` | `90000` | `src/utils/qr-login-expiry.js:1` |

`DEFAULT_STYLE` (`mybot-style.js:39-50`):

```js
{ icon: "🤖", color: "db342e",
  size: { nameServer: 18, text: 14 },
  type: { nameServer: ["bold"], text: ["none"] } }
```

---

## 1. The single envelope composer and the builder catalogue

### 1.1 The envelope formula (the one thing everything funnels through)

`buildStyledMessagePayload` (`mybot-style.js:173-260`) is the sole composer. Exact shape
(`mybot-style.js:188-192`):

```js
const iconStr     = normStyle.icon ? `${normStyle.icon} ` : "";       // trailing space
const headerLine  = `${iconStr}${nameServer}`.trim();
const groupPrefix = isGroup && senderName ? `${senderName}\n` : "";
const stateSuffix = stateIcon ? `\n${stateIcon}` : "";
const fullMsg     = `${groupPrefix}${headerLine}\n${text}${stateSuffix}`;
```

Byte-level consequences, in order:

- Line 1 is `<icon><SPACE><nameServer>` (the single trailing space is removed only by `.trim()` on the
  whole header; a leading icon followed by a space survives).
- In **groups only**, `senderName + "\n"` is prepended *above* the bot name. `senderName` is
  `message.data.dName`; an empty/absent `dName` suppresses the prefix entirely (`chat-style.js:54`).
- Line 2 is always `"\n" + text`, **even when `text` is `""`** → the composed string ends with a bare
  `"\n"` when there is no state icon. This is not cosmetic; see divergence **D2**.
- `stateIcon` is appended at the **end**, preceded by `"\n"`.
- No trailing newline after `stateIcon`.

### 1.2 Builder catalogue

All builders live in `chat-style.js` unless stated. Each is `async` and returns `undefined` (they send
directly); `sendMessageWarningRequest`, `sendMessageProcessingRequest`, `sendMessageCompleteRequest`,
`sendMessageTag` return the raw `api.sendMessage(...)` response.

#### (a) Plain DM — `api.sendMessage("text")`

- When chosen: any direct call site, e.g. `command.js:512` (`sendPhase1Result` fallbacks), `command-response.js:46`.
- Shape: a bare string is coerced to `{ msg: message }` (`sendMessage.js:510`); `type` defaults to
  `MessageType.DirectMessage` (`= 0`) when falsy (`sendMessage.js:504-505`). **No** icon, **no** name,
  **no** state icon, **no** style — the literal user-visible text.
- Style: none (`style` undefined → `textProperties` omitted, `sendMessage.js:247`).
- TTL: caller's value, else `appContext.timeMessage`, else `0` (`sendMessage.js:514`).
- Rust helper already present: `build_dm_plain` (`v3_style.rs:992-999`).

#### (b) Quoted state message — `sendMessageStateQuote(api, message, caption, state, ttl = 0, onState = true)`

- When chosen: the workhorse "did the thing / did not do the thing" reply; used in ~dozens of command
  handlers (`checkip.js:36,50,55`, `replytag.js:33`, `group-manage.js:943`, `gemini.js:365`, …).
- Icon: `state ? "✅✅✅" : "❌❌❌"` (`chat-style.js:248`), suppressed when `onState === false`
  (`chat-style.js:262`).
- Body: `caption` **verbatim** — the caller is expected to prefix its own `❌`/heading text.
- Fonts/colors: `profile.style` **unmodified** (`chat-style.js:257`) — unlike (c)–(f) it does *not* force red.
- TTL: `ttl || 60000` (`chat-style.js:265`) — so `0` → `60000`.
- Quote: yes (`chat-style.js:263`), dropped on the no-quote retry rung.
- Mentions: `[{ pos: 0, uid: senderId, len: senderName.length }]` (`chat-style.js:264`).

#### (c) Complete-wrap — `sendMessageComplete(api, message, caption, hasState = true)`

- When chosen: success acknowledgements (`gemini.js:313,352`, `cmdadd-command.js:188`).
- Icon: `"✅✅✅"` (`chat-style.js:172`).
- Color: `profile.style?.color || COLOR_RED` (`chat-style.js:182`) — **keeps the profile color**, does not force red.
- TTL: `60000` (`chat-style.js:193`). Quote: yes (`:191`). Mentions: caller mention (`:192`).

#### (d) Warning — `sendMessageWarning(api, message, caption, hasState = true)`

- Icon `"🚨🚨🚨"` (`chat-style.js:134`); color forced `COLOR_RED` (`:143-145`); TTL `60000` (`:155`);
  quote yes (`:153`); caller mention (`:154`).
- Sibling `sendMessageFailed` (`chat-style.js:205-241`) is identical except icon `"❌❌❌"` (`:210`) and it
  also forces red (`:218-220`), TTL `60000` (`:231`).

#### (e) Error-with-reference — `sendCommandError`

- Two copies exist and are **byte-identical**: `src/commands/command-response.js:41-70` and the private
  `command.js:425-465` (`sendPhase1Result` dispatches `HANDLER_ERROR` to it, `command.js:469-472`).
- Shape (`command-response.js:48`):

  ```
  Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại sau.
  Mã lỗi: CMD-XXXXXXXX
  ```

- Reference construction (`command-response.js:29-39`): seed is
  `` `${threadId}:${uidFrom}:${Date.now()}:${error.name}` ``, folded with
  `hash = (hash * 31 + charCodeAt(i)) >>> 0`, rendered `CMD-` + uppercase hex padded to 8.
  **`>>> 0` is a 32-bit unsigned fold; a `u64`/`u32` port without wrapping will diverge.**
- Envelope: **none** — plain `{ msg }`, no quote, no style, TTL resolved to
  `appContext.timeMessage || 0` (`sendMessage.js:514`).
- `command.js:429-439` pre-checks `threadId`/`type`/`data` and returns `false` **without sending** when
  the message is incomplete; `command-response.js` has no such guard.

#### (f) Insufficient-authority — `sendMessageInsufficientAuthority(api, message, caption, hasState = true)`

- When chosen: `checkPermission` failure (`command.js:211-214`), fail-closed missing policy
  (`command.js:183-192`), `checkAdminLevelHighest` (`command.js:350-357`),
  `checkAdminBotPermission` (`command.js:361-370`), `checkAdminBoxPermission` (`command.js:373-382`),
  private-chat disabled (`command.js:608-612`, `:714-718`), group-only command used in DM
  (`command.js:767-772`).
- Icon `"🚫🚫🚫"` (`chat-style.js:58`); color forced `COLOR_RED` (`chat-style.js:66-69`); TTL `60000`
  (`:79`); quote yes (`:77`); caller mention (`:78`).
- Canonical caption comes from `formatPermissionDenied` (`src/utils/role-policy.js:27-33`):

  ```
  Bạn không có đủ quyền hạn để sử dụng lệnh này.
  Yêu cầu quyền hạn tối thiểu: <label>
  ```

  Labels (`role-policy.js:13-18`): `member`→`Tất cả người dùng`, `adminBox`→`Quản trị viên nhóm`,
  `adminBot`→`Quản trị viên bot`, `adminLevelHigh`→`Quản trị viên cấp cao`.
  Aliases (`role-policy.js:20`): `all`→`member`, `adminBotOrGroup`→`adminBox`.

#### (g) Not-found / fuzzy suggestion — `checkNotFindCommand`

- `src/commands/bot-manager/utilities.js:282-343`. Transport is `sendMessageFromSQL(..., success:false, 30000)`.
- Empty command (`:285-305`):

  ```
  Nếu Mày Thắc Mắc Tao Có Những Lệnh Gì, Hãy:
  <prefix>help - Xem hướng dẫn sử dụng
  <prefix>game - Xem hướng dẫn chơi game
  <prefix>command - Xem danh sách lệnh có sẵn
  ```

  and `hasState = false` (`:298`) → **no `❌❌❌`**, though color stays the profile color.
- With suggestions (`:310-323`):

  ```
  Không tìm thấy lệnh "<command>"
  Có phải mày muốn dùng:
  <prefix><name> [<permissionLabel>]
  ```

- Without suggestions (`:324-339`):

  ```
  Không tìm thấy lệnh "<command>". Vui lòng sử dụng:
  <prefix>help - … / <prefix>game - … / <prefix>command - …
  ```

- Ranking (`utilities.js:214-277`): `isStartsWith` → 1.0; common shortcut → 0.95; ordered-subsequence
  → 0.9; else Levenshtein similarity `1 - dist / max(len)` with threshold `0.6`; sort by
  `ROLE_LEVELS[permission]` **ascending** then similarity descending; `.slice(0, 5)`.
  Shortcut table (`:222-230`): `dy→daily, dk→dangky, nt→nongtrai, tx→taixiu, kbb→keobuabao,
  tt→thongtin, bg→background`.

#### (h) Processing request — `sendMessageProcessingRequest(api, message, objectData, ttl = 0)`

- `chat-style.js:420-445`. Color forced `COLOR_YELLOW` (`:429`), font
  `size.nameServer = 14` (`:430`), `text: ""` and `objectData.caption` placed in the **nameServer slot**
  (`:435`) — i.e. the caption *becomes* the header line. Optional `objectData.imagePath` →
  `payload.attachments` (`:442`). **No quote** (`:433-441`). TTL = caller value, no default applied.
- Siblings, same skeleton: `sendMessageWarningRequest` (red, `:400-404`),
  `sendMessageCompleteRequest` (green, `:454-458`).
- Canonical TTL for a download-progress anchor: `8000` (`interaction-countdown.js:821`).

#### (i) Tag / mention message — `sendMessageTag(api, message, objectData, ttl = 0)`

- `chat-style.js:474-508`. Green (`:483`), `size.nameServer = 14` (`:484`), caption in the header slot
  (`:498`), `text: ""` (`:501`).
- Mention arithmetic **is the whole point** (`chat-style.js:487-494`):

  ```js
  const tempPrefix = isGroup ? senderName + "\n" : "";
  const adjustedMentions = [
    { pos: 0, uid: senderId, len: senderName.length },
    ...(objectData.mentions || []).map((m) => ({ ...m, pos: m.pos + tempPrefix.length })),
  ];
  ```

  The caller mention sits at `pos 0` and covers the `senderName` line; extra mentions are shifted by
  `senderName.length + 1`. **No icon-length term is added** — see divergence **D6**.
- No quote; attachments from `objectData.imagePath`.

### 1.3 Auxiliary variants worth porting verbatim

| Builder | Cite | Peculiarity |
| --- | --- | --- |
| `sendMessageQuery` | `chat-style.js:91-127` | icon `"❓❓❓"` (`:96`), forces red (`:104-107`) |
| `sendMessageStateQuote` | `chat-style.js:243-275` | the only builder mapping `ttl 0 → 60000` |
| `sendMessageState` | `chat-style.js:277-293` | **hard-codes `isGroup: true` and `MessageType.GroupMessage`** regardless of the real thread (`:284`, `:289`); no quote; swallows errors |
| `sendMessageResultRequest` | `chat-style.js:295-311` | takes `type` explicitly; no quote; TTL passed through (no 0→60000) |
| `sendMessageFromSQL` | `chat-style.js:313-345` | state icon from `result.success`; TTL passed through |
| `sendMessageImageNotQuote` | `chat-style.js:347-365` | `isGroup: true` hard-coded, `attachments`, `isUseProphylactic` flag (`:359`) |
| `sendMessageFromSQLImage` | `chat-style.js:367-391` | **no `quote` key passed** → unquoted, TTL defaults to `60000` |

### 1.4 The 4-rung send ladder (styled builders)

`sendStyledMessage` (`chat-style.js:30-51`) retries every styled builder down this ladder:

| rung | `skipQuote` | `skipStyle` | effect |
| --- | --- | --- | --- |
| `full` | false | false | quote + style + mentions |
| `no-quote` | true | false | style kept, quote **and mentions** dropped (`chat-style.js:78`) |
| `no-style` | true | true | plain text envelope, `linkOn: false` (`mybot-style.js:194-202`) |
| `plain` | true | true | identical to `no-style` |

Then a *second*, independent 5-rung ladder lives one layer down in
`sendWithQuoteFallback` (`sendMessage.js:467-493`): `original → no-quote → no-style →
no-mentions → plain`. A naive port that fails the first attempt instead of descending both ladders
will drop messages V3 delivers.

---

## 2. Style encoding

### 2.1 `MessageStyle` / `MultiMsgStyle`

`src/api-zalo/models/Message.js:45-73`:

```js
let styleValue = [];
if (bold) styleValue.push("b");
if (italic) styleValue.push("i");
if (underline) styleValue.push("u");
if (strike) styleValue.push("s");
styleValue.push("c_" + color.replace("#", ""));
styleValue.push("f_" + size);
const styleObject = { start: offset, len: length, st: styleValue.join(",") };
// autoFormat=true → JSON.stringify({ styles: [styleObject], ver: 0 })
```

- Token order is **fixed**: `b,i,u,s` then `c_<hex>` then `f_<size>`. `c_`/`f_` are always present.
- `MessageStyle` defaults are `color = "ffffff"`, `size = "18"`, and `autoFormat = true`
  (`Message.js:45`) — but `mybot-style.js:222` and `:245` pass `false`, so spans stay objects.
- `MultiMsgStyle` (`Message.js:75-89`) JSON-parses any string rung and re-emits
  `JSON.stringify({ styles, ver: 0 })` — compact, key order `styles` then `ver`, each span key order
  `start`, `len`, `st`.
- Sizes are **strings** in `st` (`"f_18"`), but `start`/`len` are **numbers**.

### 2.2 Span computation (`mybot-style.js:204-250`)

```js
const headerOffset = groupPrefix.length;      // 0 or senderName.length + 1
const headerLength = headerLine.length;
styles.push(MessageStyle(headerOffset, headerLength, color, String(size.nameServer),
                         isNameBold, isNameItalic, isNameUnderline, isNameStrike, false));

const textOffset = headerOffset + headerLength + 1;   // +1 for the "\n"
const textLength = text.length;
if (textLength > 0 && (isTextBold||isTextItalic||isTextUnderline||isTextStrike
                       || normStyle.size.text !== 14)) {
  styles.push(MessageStyle(textOffset, textLength, color, String(size.text), …));
}
```

**Units: UTF-16 code units.** `.length` in JavaScript counts UTF-16 code units, not Unicode scalar
values and not bytes. Therefore:

- A Vietnamese letter in **precomposed** form (`ế` = U+1EBF) is **1 unit**; in **decomposed** form
  (`e` + U+0302 + U+0301) it is **3 units**. V3 never normalizes, so the two forms produce different
  `len`. A Rust port must **not** call `unicode-normalization` before measuring.
- `🤖` (U+1F916) is **2 units** (`surrogate pair`) → `DEFAULT_STYLE.icon` costs 2 in
  `headerLength`, plus 1 for the space.
- `✅`, `❌`, `🚨`, `🚫`, `❓`, `🕑` are all non-BMP → 2 units each. `"✅✅✅"` is **6 units** and
  therefore shifts nothing (it is last) but occupies 6 in the message body.
- `len` is measured on the **untrimmed** `text`; `headerLine` is measured **after** `.trim()`.

Rust already has `utf16_len` (`rust/crates/mybot-types/src/lib.rs:292-294`) and uses it correctly at
`v3_style.rs:404-405,419`.

### 2.3 Palette

`SAFE_COLORS` (`mybot-style.js:3-18`) — the allow-list, in order:

`db342e` red, `15a85f` green, `f7b503` yellow/gold, `0084ff` blue, `ff69b4` pink, `8a2be2` purple,
`00ffff` cyan, `ffffff` white, `ff4500` orange-red, `32cd32` lime, `1e90ff` dodger blue, `9370db`
medium purple, `ffa500` orange, `00fa9a` spring green.

`COLOR_NAMES` (`mybot-style.js:20-33`) — name → hex:

| name | hex |
| --- | --- |
| `red` | `db342e` |
| `green` | `15a85f` |
| `yellow` | `f7b503` |
| `gold` | `f7b503` |
| `blue` | `0084ff` |
| `pink` | `ff69b4` |
| `purple` | `8a2be2` |
| `cyan` | `00ffff` |
| `white` | `ffffff` |
| `orange` | `ffa500` |
| `black` | `000000` |
| `lime` | `32cd32` |

Note `black` (`000000`) is a valid *name* but is **absent** from `SAFE_COLORS`.

### 2.4 Normalization / validation rules

`normalizeColor` (`mybot-style.js:52-66`):
1. non-string → default (`db342e`);
2. `.trim().toLowerCase()`;
3. exact `COLOR_NAMES` hit → mapped hex;
4. strip one leading `#`;
5. 3-char hex is **expanded by doubling each digit** (`abc` → `aabbcc`) (`:59-61`);
6. `/^[0-9a-f]{6}$/` → accepted as-is;
7. otherwise → default. **Invalid colors never throw.**

`normalizeSize` (`mybot-style.js:68-72`): `parseInt(x,10)`; non-integer → default; else **clamp to
`[10,24]`** — out-of-range is clamped, not rejected.

`normalizeType` (`mybot-style.js:74-90`): accepts array or a string split on `/[\s,]+/`; each entry
`String().trim().toLowerCase()`; keeps only `VALID_TYPES = ["bold","italic","underline","strike","none"]`
(`:35`); empty result → default; **if `"none"` is present the result collapses to `["none"]`**
(`:86-88`); otherwise de-duplicated in first-seen order (`:89`).

`normalizeStyle` (`mybot-style.js:154-168`): applies the above field-by-field; icon falls back to `"🤖"`
unless it is a non-empty trimmed string.

`validateStyle` (`mybot-style.js:92-152`) is the *rejection* predicate used by profile editing, not by
the send path: icon must be a string of length 1–10 (`:100`); color must be a name or 3/6-digit hex
(`:105-113`); sizes must be integer 10–24 (`:119-131`); `type.*` entries must be in `VALID_TYPES`
(`:134-149`). Errors are collected, never thrown.

`getProfile` (`src/commands/mybot/System/mybot-profile-service.js:141-174`) always re-runs
`normalizeStyle`, and `nameServer` validation caps at 80 chars (`:108`).

### 2.5 When the text span is emitted

The second span exists **only if** `text.length > 0` **and** (any of bold/italic/underline/strike **or**
`size.text !== 14`) — `mybot-style.js:234`. So a default profile with `text: ["none"]` and `size.text: 14`
emits exactly **one** span covering the header. This is why the common case is a 1-span `MultiMsgStyle`.

### 2.6 `plain` / `skipStyle` payload

`mybot-style.js:194-202`:

```js
{ msg: fullMsg, ttl, linkOn: false,
  ...(skipQuote || !quote ? {} : { quote }),
  ...(mentions && mentions.length > 0 ? { mentions } : {}) }
```

`mentions` and `quote` keys are **omitted**, not `null`, when empty. `linkOn: false` is always set in
both branches (`:198`, `:256`).

---

## 3. Mentions

### 3.1 Units and keys

- Outbound span shape is `{ pos, len, uid, type }` where `type = uid === "-1" ? 1 : 0`
  (`src/api-zalo/models/Message.js:31-36`). `MessageMention(uid, length = 1, offset = 0, autoFormat = false)`
  is the constructor (`:26-43`); when `autoFormat` it returns `JSON.stringify([mention])`.
- `pos`/`len` are **UTF-16 code units** — same measure as the style spans, both derived from JS
  `.length` (`chat-style.js:78`, `:490-493`).
- On the wire the array is serialised into a field named **`mentionInfo`** (a JSON *string*), not
  `mentions` (`sendMessage.js:235`, `:252`), and only when `mentionsFinal.length > 0 && isGroupMessage`
  (`:228`).

### 3.2 Server-side filtering (`sendMessage.js:189-212`)

```js
const mentionsFinal = Array.isArray(mentions) && type == MessageType.GroupMessage
  ? mentions.filter((m) => m.pos >= 0 && m.uid && m.len > 0)
            .map((m) => ({ pos: m.pos, uid: m.uid, len: m.len,
                           type: m.uid == "-1" ? 1 : 0 }))
  : [];
if (totalMentionLen > msg.length)
  throw new ZaloApiError("Invalid mentions: total mention characters exceed message length");
```

Three rules a port must keep: **(1) DM mentions are silently discarded**; **(2) invalid spans are
dropped, not errors**; **(3) the sum of `len` is compared against `msg.length`** and throws.

### 3.3 `@All`

There is no `"@All"` literal. Two encodings:

1. **All-members, one span:** `uid: -1` (`number`) with `len = contentTag.length`
   (`src/service-debug/chat-zalo/chat-general/chat-all.js:45`). `type` becomes `1` **only** because
   `MessageMention` compares `uid === "-1"` (string) — but `addReaction`/`sendMessage` coerce via
   `m.uid == "-1"` (loose, `sendMessage.js:201`). A strict-typed port must treat both `-1` and `"-1"`
   as "all".
2. **Per-member fan-out:** when the bot is not a group admin V3 appends one space per member and emits
   a span per member (`chat-all.js:22-30`):

   ```js
   const mentions = (groupInfo.memVerList || []).map((member) => {
     const pos = newChatMessage.length;
     newChatMessage += " ";
     return { pos, uid: String(member).split("_")[0], len: 1 };
   });
   ```

   Member ids are `"<uid>_<something>"`; only the part before `_` is used, and each span covers exactly
   one space.

### 3.4 Inbound mention stripping

`removeMention` (`src/utils/format-util.js:263-283`): take `content.title || content`; sort mentions by
`pos` **descending**; `content.replace(content.substr(pos, len), "")` for each (note: `String.replace`
with a string pattern removes the **first** occurrence of that substring, not the one at `pos` — a V3
quirk worth replicating literally); then `.replace(/\s+/g, " ").trim()`.
Rust equivalent: `remove_mentions_utf16` (`mybot-types/src/lib.rs:296-…`).

---

## 4. Quote behaviour

### 4.1 Which paths quote

| Path | Quote? | Cite |
| --- | --- | --- |
| `sendMessageInsufficientAuthority`, `sendMessageQuery`, `sendMessageWarning`, `sendMessageComplete`, `sendMessageFailed`, `sendMessageStateQuote`, `sendMessageFromSQL` | **yes** | `chat-style.js:77,115,153,191,229,263,333` |
| `sendMessageState`, `sendMessageResultRequest`, `sendMessageImageNotQuote`, `sendMessageFromSQLImage` | **no** | `:281-288`, `:299-306`, `:350-357`, `:376-384` |
| `sendMessageWarningRequest`, `sendMessageProcessingRequest`, `sendMessageCompleteRequest`, `sendMessageTag` | **no** | `:406-414`, `:433-441`, `:460-468`, `:496-504` |
| `sendCommandError` | **no** | `command-response.js:46-52` |
| `sendNotFindCommand` | **yes** (via `sendMessageFromSQL`) | `utilities.js:287`, `:311`, `:325` |
| `!cmd` page split | **first part only** | `help.js:653`, `:679` |
| `!cmdadd list` split | **first part only** | `cmdadd-command.js:147` |
| `prefix.js` menu | yes, with fallback to no-quote | `prefix.js:19-42`, `:68-152` |

Every styled builder passes `quote: message` and the ladder at `chat-style.js:30-36` drops it on rung 2.

### 4.2 What quoting changes on the wire (`sendMessage.js:229-271`)

When `quote` is set the params block gains: `qmsgOwner`, `qmsgId` (`quote.data.msgId`), `qmsgCliId`
(`quote.data.cliMsgId`), `qmsgType` (`getClientMessageType(quote.data.msgType)`), `qmsgTs`
(`quote.data.ts`), `qmsg` (string content, or `prepareQMSG` for `chat.todo`), `qmsgAttach`
(group only, `prepareQMSGAttach`), `qmsgTTL` (`quote.data.ttl`) — and the URL path becomes
`…/api/message/quote` or `…/api/group/quote` (`:266-268`). Without a quote the suffix is
`/sendmsg` if there is no `mentionInfo`, `/mention` if there is, and `/sms` for DMs (`:269-271`).
Two quote types are hard-rejected: a non-string `content` with `msgType == "webchat"`
(`:221-223`) and `msgType == "group.poll"` (`:224-226`).

### 4.3 Recognising a reply to a *bot* message

The quoted object carries `globalMsgId`, `cliMsgId`, `msgId`, `uidFrom`/`ownerId`, `ts`, `msg`, `attach`.
Identity of "this is my own message" is `uidFrom === "0"`:

- `quote.ownerId === "0"` → treat as the bot (`recent-message.js:19`).
- `msg.uidFrom === "0" ? getBotId() : msg.uidFrom` (`recent-message.js:61`, `:152`; `spotify.js:547`).

Session lookup keyed on the **server id**, with a `cliMsgId` backfill:

- `openMediaSelection`'s cleanup (`interaction-countdown.js:888-904`) compares
  `quote.globalMsgId || quote.msgId` against the stored `globalMsgId || msgId`, and if they match and
  the stored ref lacks `cliMsgId`, it copies `quote.cliMsgId` in.
- `findSelectionRecordForMessage` (`api-crawl/index.js:200-211`) keys on
  `message.data.quote.globalMsgId ?? message.data.quote.msgId`, then falls back to sender id.
- The same `quote.globalMsgId.toString()` key pattern repeats in `scan-group.js:197-199`,
  `remote-action-group.js:290-293`, `aio-downlink.js:856-858`, `zingmp3.js:605`, `soundcloud.js:312`,
  `nhaccuatui.js:368`, `clipphot.vn.js:256`, `spotify.js:439-441`.

Deletion/recall of a bot message requires **both** ids plus the bot uid
(`recallBotMessage`, `interaction-countdown.js:440-456`: refuses unless `msgId` **and** `cliMsgId`
are non-empty; `recent-message.js:140-143` matches on `cliMsgId` **and** `msgId`).

`undoMessage.js:25` and `sendCustomerSticker.js:51` also read `message.data?.quote`.

---

## 5. Reaction confirmation (`sendReactionConfirmReceive`)

- Definition: `src/commands/command-response.js:1-27`. Re-exported from `command.js:2-3`.
- **Gate 1 — numeric type:** returns `false` unless `numHandleCommand` is `undefined` or one of
  `[1, 2, 3, 5]` (`command-response.js:2-4`). Type `4` (and `0`, `99`) never react.
- **Gate 2 — dispatcher:** the group path also requires `[1,2,3].includes(numHandleCommand)` **and**
  (`isCallerAdmin || groupSettings[threadId]?.activeBot === true`) (`command.js:986-992`); the private
  path uses the same set with (`isCallerAdmin || privateEnabled || managerData.data.onBotPrivate`)
  (`command.js:726-733`).
- **Explicit type-3 sites** (custom commands, `prefix`): `command.js:543`, `:584`, `:863`;
  plus `auto-download.js:185,208` and `youtube-autodownload-workflow.js:9` pass `5`.
- **Icon:** the literal string `"thanks"` (`command-response.js:14`) → `ReactionMap.thanks =
  { text: "/-thanks", rType: 111 }` (`src/api-zalo/models/Reaction.js:41`). The wire `rIcon` is
  `"/-thanks"`, **not** the 👍 emoji and **not** ❤️. (`❤️`/`HEART` is `rType 5`, used separately for
  join-group confirmation at `remote-action-group.js:111`.)
- **Idempotency:** a truthy `message._confirmReactionSent` short-circuits to `true` (`:9-11`); the flag
  is set only on success (`:15`).
- **Target id:** `message.data.msgId || message.data.cliMsgId || message.msgId` (`:5`); requires
  `api.addReaction`, an id, and `threadId` (`:6-8`).
- **Timing:** fire-and-await **before** dispatch, after permission and cooldown gates, right before
  `dispatchCommand` (`command.js:986-999`).
- **Payload** (`addReaction.js:55-73`): `react_list[]` of
  `{ message: JSON.stringify({ rMsg, rIcon, rType, source: 6 }), clientId: Date.now() + index }` where
  each `rMsg` entry is `{ gMsgID: parseInt(msgId), cMsgID: parseInt(cliMsgId), msgType: parseInt(type) }`.
  **Both ids are `parseInt`-ed to numbers** — 19-digit ids exceed `Number.MAX_SAFE_INTEGER` and silently
  lose precision. `clientId` is `Date.now() + index`.
- **Undo/delete of the reaction:** a `ReactionMap.UNDO = { text: "", rType: -1 }`
  (`Reaction.js:4`) applied over the same message reference removes the bot's order-dependent reaction
  layer. Countdown frames rely on this (see §6). The dispatcher itself never undoes the `thanks`
  reaction; inbound-reaction handlers ignore `rType <= 0` (`locmem-tracker.js:126,136-138`).

---

## 6. Menu lifecycle (numbered menus, `🕑`/`CLOCK` countdown)

### 6.1 The icon

`ReactionMap.CLOCK = { text: "🕑", rType: 55 }` (`Reaction.js:39`). The builder
`buildCountdownReaction(remaining)` ignores its argument and returns the constant `"CLOCK"`
(`interaction-countdown.js:312-314`; same for `qr-login-countdown.js:16-18` and
`qr-login-prefix-countdown.js:11-13`).

### 6.2 How the countdown is rendered — it is a *count of identical clocks*

`buildReactionOperations` (`interaction-countdown.js:324-338`) turns a count into
`[{ icon, messages: Array(size).fill(messageRef) }]` where `size = min(remaining, maxBatchSize)` and
`maxBatchSize = MAX_REACTION_BATCH_SIZE = 50` (`:316`). So a 120 s window renders **50 + 50 + 20**
clocks in three `rMsg` arrays inside one `react_list`.

`replaceCountdownReactionFrame` (`:389-415`) is the frame swap:

```js
const operations = [
  ...buildReactionOperations({ icon: "UNDO", messageRef, count: current }),
  ...buildReactionOperations({ icon: "CLOCK", messageRef, count: next }),
];
```

i.e. UNDO every clock currently attached, then attach `next`. No delete of the message, no edit.

### 6.3 Cadence and arithmetic

- Tick interval: `session.schedule(tick, 1000)` (`:646`, `:679`, `:719`) — **1000 ms**.
- Remaining: `Math.max(0, Math.ceil((expiresAt - now()) / 1000))` (`:631`) — `expiresAt` is computed
  from `startTime + durationMs` where `durationMs = timeoutMs ?? seconds * 1000` (`:534-535`), so the
  clock face shows **ceil**, i.e. the first frame shows the full duration and the last shows `1`.
- At `remaining <= 0` → `handleExpiry` (`:634-637`), which UNDOes the last frame (`:586-596`), runs
  `onExpire` (`:598-606`), then optionally recalls the message (`:608-616`).
- `showCooldownClock` derives `seconds` as `Math.max(1, Math.ceil(remainingMs / 1000))` but passes the
  exact `timeoutMs`, so sub-second cooldowns still show one clock (`:778-797`).
- Sessions are keyed in a module-level `Map` (`:15`); starting a second session with the same key
  cancels the first (`:556-562`). `completeInteractionCountdown` sets `stopped = true`, cancels the
  timer, UNDOes the rendered count and returns `true` (`:726-772`).

### 6.4 Recall on selection vs recall on expiry

- **On expiry:** `deleteOnExpire: true` → `recallBotMessage` (`:608-616`) → `api.undoMessage`.
  `recallBotMessage` retries `maxRetries = 2` with `delayMs = 300` linear backoff, only for
  status 408/429/≥500 (`:417-421`, `:467-493`).
- **On selection / claim:** `openMediaSelection`'s `finish()` calls `completeInteractionCountdown`
  then `cleanupPromptMessage` (`:919-931`), which recalls the prompt when `targetRef.data.msgId` and
  `cliMsgId` are both present (`:905-916`). Countdown removal precedes the recall.
- Menu handlers additionally delete explicit entries: `requestJoinGroupMap.delete(msgId)` (`:97`),
  `downloadSelectionsMap.delete(quotedMsgId)` (`spotify.js:475,507,516,534`), and the prompt delete at
  `spotify.js:540-554`.

### 6.5 The 90 / 120 / 180 s families

| Family | Window | Mechanism | Cite |
| --- | --- | --- | --- |
| QR-login session | **90 s** | `QR_LOGIN_TIMEOUT_MS = 90000`; on expiry: abort signal with reason `"qr_expired"`, stop clocks, **recall the QR image** | `qr-login-expiry.js:1-2`; `qr-login-countdown.js:44,57,123-150` |
| Music / media selection (`spotify`, `zingmp3`, `soundcloud`, `nhaccuatui`, `spotify-downlink`) | **120 s** | `TIME_WAIT_SELECTION = 120000`; used as the *menu message TTL*; the reaction window is `seconds: 60` | `music/spotify.js:24,388`; `api-crawl/spotify/spotify-downlink.js:29,350`; `:375,557` |
| `download/aio-downlink`, `tiktok-service`, `scan-group`, `api-hoangdev/aio-downlink` | **60 s** | `TIME_WAIT_SELECTION = 60000` passed as TTL *and* `seconds: Math.floor(TTL/1000) \|\| 60` | `download/aio-downlink.js:288`; `tiktok-service.js:40,573,589`; `scan-group.js:14,17,171`; `api-hoangdev/aio-downlink.js:240,741` |
| QR delta-prefix prompt | **60 s** | `seconds: 60`, `deleteOnExpire: true`; message itself `ttl: 300000` | `qr-login-command.js:628,654` |
| Join-group confirmation | **30 s** | `waitingActionJoinGroup = 30000`; reaction **LIKE or HEART** (`rType 3 \|\| 5`) claims it; Map TTL is `2 × 30000` | `remote-action-group.js:21,23,94,110-111` |
| `mybot-active` bot picker | **60 s** | `ttl: 60000` + `seconds: 60` | `mybot-active-selection.js:165,190` |
| Cooldown clock | dynamic | `Math.ceil(remainingMs/1000)` | `check-countdown.js:5-12`; `interaction-countdown.js:778-797` |

Note the split for media menus: the **message TTL is 120 s** but the **clock window is 60 s** —
the prompt survives longer than its countdown.

---

## 7. Multi-message splitting

**There is no global sender-side limit.** `api.sendMessage` never splits; the only server-side guard is
`if (!msg || msg.length == 0) throw` (`sendMessage.js:214`). Splitting happens per call site, and the
two live implementations disagree:

| Site | Max chars | Rule | First-part-only quote/style? |
| --- | --- | --- | --- |
| `!cmd` / `sendListCommands` | **2000** | `splitMessage(message, maxLength = 2000)` (`help.js:369`): accumulate whole `"\n"`-separated lines; when `currentPart + line + "\n"` would exceed, flush `currentPart.trim()`; a single line longer than 2000 is hard-chunked by `line.match(/.{1,2000}/g)` | **yes** — `style: i === 0 ? fallback.style : null`, `quote: i === 0 ? message : null` (`help.js:652-653`, `:673`, `:679`) |
| `!cmdadd list` | **3500** | `splitMessage` (`cmdadd-command.js:237-252`) also iterates lines but compares `current.length + word.length + 1 > 3500` and joins with `"\n"`; a lone over-long line is **never** chunked | **yes** — `quote: i === 0 ? message : null` only; no style is ever applied (`cmdadd-command.js:147`) |

Other limits found, all *validators* rather than splitters:
`MAX_TEXT_LENGTH = 2000` rejects a too-long custom-command body
(`cmdadd-command.js:21,52-53`); `sanitizeInput(input, maxLength = 1000)` truncates QR-login text
(`qr-login-command.js:88-94`); `group-manage.js:942` chunks a blocked-user list at 50 names per message.

So: **only the first part is quoted (and styled)**; parts 2..n are bare `{ msg }` with the same TTL.

---

## 8. TTL matrix

Column meanings: **Quote** = does the send attach `quote`; **Recall on expiry** = does anything later
call `undoMessage` on this message when a deadline passes. `—` = no.

| # | Command family | TTL ms | Quote | Recall on expiry | Cite |
| --- | --- | --- | --- | --- | --- |
| 1 | insufficient-authority (`sendMessageInsufficientAuthority`) | 60000 | yes | — | `chat-style.js:79,77` |
| 2 | query / syntax prompt (`sendMessageQuery`) | 60000 | yes | — | `chat-style.js:117,115` |
| 3 | warning (`sendMessageWarning`) | 60000 | yes | — | `chat-style.js:155,153` |
| 4 | complete-wrap (`sendMessageComplete`) | 60000 | yes | — | `chat-style.js:193,191` |
| 5 | failed (`sendMessageFailed`) | 60000 | yes | — | `chat-style.js:231,229` |
| 6 | state-quote, `ttl` argument = 0 | 60000 | yes | — | `chat-style.js:265,263` |
| 7 | state-quote, explicit ttl (`1500`/`5000`/`20000`/`60000`/`120000`/`180000`/`1800000`) | caller | yes | — | `chat-style.js:265`; `checkip.js:36,50,55` |
| 8 | `sendMessageState` (group-locked) | caller (0 allowed) | **no** | — | `chat-style.js:277-289` |
| 9 | `sendMessageResultRequest` | caller (e.g. `30000`, `12000`) | **no** | — | `chat-style.js:295-311`; `active-bot.js:48`; `remote-action-group.js:178,182` |
| 10 | `sendMessageFromSQL` (not-found, remote actions) | `30000` typical | yes | — | `chat-style.js:336,333`; `utilities.js:299,322,337` |
| 11 | `sendMessageFromSQLImage` | 60000 (builder default) | **no** | — | `chat-style.js:376-384` |
| 12 | `sendMessageImageNotQuote` | caller | **no** | — | `chat-style.js:350-357` |
| 13 | warning-request (`sendMessageWarningRequest`) | `20000` / `30000` / `180000` | **no** | — | `chat-style.js:406-414`; `nqduan-phase5.js:626`; `music/spotify.js:317,425`; `remote-action-group.js:148` |
| 14 | processing-request / download anchor | `8000` default | **no** | **yes** (recalled on completion) | `interaction-countdown.js:821,846-862`; `chat-style.js:433-441` |
| 15 | complete-request (selection menu) | `120000` / `180000` / `60000` / `30000` | **no** | **yes** (`deleteOnExpire`) | `chat-style.js:460-468`; `music/spotify.js:24,388`; `google-search.js:91`; `scan-group.js:17`; `remote-action-group.js:77` |
| 16 | tag / mention (`sendMessageTag`) | caller (0 = passthrough) | **no** | — | `chat-style.js:496-504` |
| 17 | command error-with-reference | `0` → `appContext.timeMessage` | **no** | — | `command-response.js:46-52`; `sendMessage.js:514` |
| 18 | not-found, empty command | 30000 | yes | — | `utilities.js:287-300` |
| 19 | not-found, fuzzy suggestion | 30000 | yes | — | `utilities.js:311-323` |
| 20 | `prefix` menu (list/set/reset) | 30000 | yes | — | `prefix.js:68-139` |
| 21 | `prefix` success confirmation | 60000 | yes | — | `prefix.js:148-152` |
| 22 | `checkip` usage error | 60000 | yes | — | `lenh-debug/check/checkip.js:36` |
| 23 | `checkip` result | 1800000 | yes | — | `checkip.js:55` |
| 24 | `gemini` / AI chat reply | 1800000 | yes | — | `assistant-ai/gemini.js:365`; `gemini-command.js:110` |
| 25 | `gemini` reset / media analysis | 60000 | yes | — | `gemini.js:313,352` |
| 26 | `replytag` on/off toggle | 30000 | yes | — | `bot-check/replytag.js:33-39` |
| 27 | mention auto-reply (`@bot`) | 3600000 | yes | — | `replytag.js:55-61` |
| 28 | `!cmd find` results | 60000 | yes | — | `instructions/help.js:462-466` |
| 29 | `!cmd load` (reload stats) | 300000 | yes | — | `help.js:486` |
| 30 | `!cmd` page (text fallback / image) | 180000 | yes (first part) | — | `help.js:598,604,604-679` |
| 31 | `!cmd map` | 300000 | yes | — | `help.js:520-524` |
| 32 | `!cmdadd list` | 180000 | first part only | — | `cmdadd-command.js:126,147` |
| 33 | custom-command reply | 60000 | yes | — | `executor.js:91-103` |
| 34 | media menu: spotify / zingmp3 / soundcloud selection | 120000 | **no** | **yes** (prompt deleted on select and on expiry) | `music/spotify.js:24,388`; `:540-554`; `zingmp3.js:454,561`; `soundcloud.js:263` |
| 35 | media menu: `scan-group` | 60000 | **no** | **yes** | `scan-group.js:14,17,171` |
| 36 | media menu: `download/aio-downlink` | 60000 | **no** | **yes** | `download/aio-downlink.js:288`; `:884` |
| 37 | media menu: `tiktok` selection | 60000 | **no** | **yes** | `tiktok-service.js:40,573,589` |
| 38 | `mybot` active-bot picker | 60000 | yes | **yes** | `mybot-active-selection.js:163-170,190`; `api-crawl/index.js:151-164` |
| 39 | join-group confirmation | 30000 | **no** | **yes** (`deleteOnExpire`) | `remote-action-group.js:21,68-99` |
| 40 | QR-login delta-prefix prompt | 300000 (message) / 60 s (clock) | **no** | **yes** | `qr-login-command.js:628,649-659` |
| 41 | QR-login helper message | 120000 | yes → falls back to no-quote | — | `qr-login-command.js:96-107` |
| 42 | QR-login image session | 90000 (clock) | — | **yes** (QR recalled, `abort("qr_expired")`) | `qr-login-expiry.js:1-2`; `qr-login-countdown.js:123-150` |
| 43 | `infoBot` status | 120000 | no | — | `mybot/Manager/infoBot.js:185` |
| 44 | `nqduan` phase-5 replies | 120000 | yes | — | `nqduan-phase5.js:146,185,227,407` |
| 45 | group management (`block list`, help) | 300000 / 180000 / 60000 | yes | — | `group-manage.js:631,943-963,969-1000` |
| 46 | `leavegroup` notice | 30000 | **no** | — | `remote-action-group.js:178,182` |
| 47 | `simsimi` passive reply | 180000 | yes | — | `chat-bot/simsimi/simsimi-api.js:59` |
| 48 | `chattag` / `group-manage` 300000 family | 300000 | yes | — | `group-manage.js:543,621,646,657` |

**Row count: 48.**

---

## 9. Sanitization

### 9.1 The rule V3 actually applies

There is **no global markdown stripper in V3's send path.** `buildStyledMessagePayload` passes
`nameServer` and `text` through untouched (`mybot-style.js:188-192`); `handleMessage` sends them
untouched (`sendMessage.js:213-280`). Markdown reaches the user verbatim unless a call site strips it.

The one stripping site, verbatim (`src/service-debug/api-crawl/assistant-ai/gemini.js:352`):

```js
await sendMessageComplete(api, message, (r.text || "").replace(/\*\*/g, "").trim(), false);
```

- Rule: remove **every** `**` pair token (`/\*\*/g`), then `.trim()`.
- Scope: **body only** — the AI answer. `nameServer`/bot name is never sanitized.
- Timing: **before** the template render — the cleaned string is the `caption` argument, so the
  envelope is `icon + name + "\n" + cleaned_body + (stateIcon ? "\n"+stateIcon : "")`.
- Backticks are **not** removed here. Single `*`, `_`, `~~`, `#`, `>` are **not** removed here.

The only other markdown-aware code is *detection* for header extraction, not stripping:
`/\*\*(.*?)\*\*/` or `/__(.*?)__/` is used to pick the "bold line" out of a multi-line server name
(`checkip.js:23`, `ff.js:34`, `soxo.js:25`, `emote.js:33`, and ~18 more). `getCleanNameServer`
then keeps the raw line, `**` included.

`anti-badword.js:132` does `.replace(/\*/g, " ")` for its own text normalization — unrelated to outbound.

### 9.2 What this means for the Rust port

`v3_style.rs:331-336` implements `sanitize_no_markdown` as `replace("**","").replace('`',"")`, and
`build_styled_outbound` applies it to **both** `name_server` and `text` (`:378-379`). It is additionally
applied in `pipeline.rs` at `:535`, `:1218`, `:1220`, `:1281`, `:1369`, `:1517`, `:1537`, `:1585`.
That is **wider than V3** in four ways: wrong field (header), wrong token (backtick), wrong layer
(template output), wrong breadth (every reply). See divergence **D3**.

---

## 10. The 8 divergences a naive Rust port gets wrong

**D1 — UTF-16 offsets.** `start`/`len`/`pos`/`len` are JS `.length` = UTF-16 code units
(`mybot-style.js:204-232`, `Message.js:45`, `chat-style.js:78`). Emoji cost 2, Vietnamese precomposed
cost 1, decomposed cost 3. A port using `str.len()` (bytes) or `chars().count()` shifts every
subsequent span; the text span lands mid-glyph and Zalo drops the styling or renders garbage.
Rust: keep `utf16_len` (`mybot-types/src/lib.rs:292-294`) and never normalize the input.

**D2 — The `"\n"` before an empty body.** V3 always composes
`groupPrefix + headerLine + "\n" + text + stateSuffix` (`mybot-style.js:192`), so the request/tag
builders (`text: ""`) produce a **trailing newline**. `v3_style.rs:398-402` instead emits
`format!("{group_prefix}{header_line}")` when both body and state are empty — one byte shorter than V3
for every `sendMessageTag` / `*Request` message.

**D3 — Sanitization applied where V3 applies none.** V3 strips only `**` from one AI call site's body
before render (`gemini.js:352`). The port strips `**` *and* backticks from nameServer, body, studio
templates and error strings (`v3_style.rs:378-379`; `pipeline.rs:535,1218,1220,1281,1369,1585`), so a
bot named `**HHH**` or a command that legitimately prints a backtick diverges.

**D4 — Mentions.** V3 (a) drops all mentions when `type != GroupMessage`, (b) filters
`pos >= 0 && uid && len > 0`, (c) forces `type = (uid == "-1") ? 1 : 0`, (d) throws when
`Σ len > msg.length`, and (e) ships the array as the JSON **string** `mentionInfo`
(`sendMessage.js:189-212`, `:235`). A port that keeps `mentions` on DMs, sends a `mentions` field, or
omits the sum guard will produce 400s or silently unstyled replies.

**D5 — `ttl: 0` is not "no TTL".** `sendMessage` does `ttl = ttl || appContext.timeMessage || 0`
(`sendMessage.js:514`), so an explicit `0` inherits the account default. Only `sendMessageStateQuote`
maps `0 → 60000` (`chat-style.js:265`); `sendMessageState` (`:287`), `sendMessageResultRequest`
(`:305`), `sendMessageFromSQL` (`:335`), `sendMessageTag` (`:503`) and the `*Request` builders pass `0`
straight through. Applying a uniform `0 → 60000` default anywhere else changes disappearing-message
behaviour.

**D6 — Tag-message mention offset.** V3 shifts extra mentions by `tempPrefix.length` only
(`chat-style.js:487-494`) because `text: ""` means the caption *is* the header line. `v3_style.rs:743-762`
adds `prefix_shift + icon_shift` — the icon length (`"🤖 "` = 3 units) is **not** part of V3's shift,
so every extra mention lands 3 units late and highlights the wrong characters.

**D7 — Reaction confirmation gate and encoding.** The `thanks` reaction fires only for
`numHandleCommand ∈ {1,2,3,5}` (`command-response.js:2-4`), only after permission/cooldown, only when
the dispatcher's own `[1,2,3]` + admin/activeBot gate passes (`command.js:726-733`, `:986-992`), and it
is sent as `rIcon: "/-thanks"`, `rType: 111`, `source: 6` with **`parseInt`-ed** `gMsgID`/`cMsgID`
(`addReaction.js:55-73`). A port that reacts to every command, reacts with the 👍 emoji, or passes ids
as strings diverges on three axes at once.

**D8 — The `CLOCK` countdown is N identical 🕑 reactions replaced frame-by-frame.** Each tick computes
`ceil((expiresAt - now)/1000)` (`interaction-countdown.js:631`) and re-renders by UNDOing the previous
count and applying the new one (`:389-415`), batched at 50 `rMsg` per operation (`:316,324-338`),
every 1000 ms (`:646,679`), with the final frame UNDOed at expiry and the message optionally recalled
(`:586-616`). A port that shows one clock, counts up, or sends one reaction per tick will visibly
diverge, and one that forgets the 50-cap will silently truncate long windows.

Two more that commonly slip through and are worth checking: `linkOn: false` on every styled payload
(`mybot-style.js:198,256`) — if a port leaves `link_on = true`, a single-link message is routed through
`api.sendLink` instead of the text endpoint (`sendMessage.js:549-557`), a completely different envelope;
and the **two** fallback ladders (`chat-style.js:30-36` and `sendMessage.js:467-474`) that must both
descend before a send is declared failed.

---

## Danh sách kiểm để so khớp

Checklist for `rust/crates/mybot-core/src/v3_style.rs` and `rust/crates/mybot-core/src/pipeline.rs`.

### A. Envelope string

- [ ] `full_msg == group_prefix + header_line + "\n" + body + state_suffix` **without exception**, even when `body == ""` (fix `v3_style.rs:398-402`; V3 `mybot-style.js:192`).
- [ ] `header_line` = `icon + " " + name_server` then `.trim()`; a trimmed-empty name yields just the icon, and an empty icon yields no leading space (`mybot-style.js:188-189`).
- [ ] `group_prefix` present **only** when `is_group && sender_name != ""`, and it ends with exactly one `"\n"` (`mybot-style.js:190`).
- [ ] `state_icon` appended as `"\n" + icon`, never with a trailing newline (`mybot-style.js:191`).
- [ ] `sender_name` is `message.data.dName`; absent/empty ⇒ no prefix (`chat-style.js:54`).
- [ ] No trailing whitespace is added or removed anywhere else.

### B. Style spans

- [ ] Offsets measured with `utf16_len`, never `len()` / `chars().count()` (`mybot-types/src/lib.rs:292`).
- [ ] `header.start = utf16(group_prefix)`, `header.len = utf16(header_line)` (`mybot-style.js:204-205`).
- [ ] `text.start = header.start + header.len + 1`, `text.len = utf16(body)` (`mybot-style.js:231-232`).
- [ ] Second span emitted **iff** `body.len > 0 && (any of bold/italic/underline/strike || size.text != 14)` (`mybot-style.js:234`).
- [ ] JSON exactly `{"styles":[…],"ver":0}`, compact, spans keyed `start`,`len`,`st` (`Message.js:59-63,83-86`).
- [ ] `st` token order `b,i,u,s,c_<hex>,f_<size>`; `c_` and `f_` always present; size rendered as an integer inside the string (`Message.js:50-57`).
- [ ] `start`/`len` are numbers; `f_` value is the clamped `10..24` integer (`mybot-style.js:68-72`).

### C. Palette & normalization

- [ ] `COLOR_NAMES` has all 12 entries incl. `black→000000`, `gold→f7b503` (`mybot-style.js:20-33`).
- [ ] 3-digit hex expands by doubling digits (`abc→aabbcc`) (`mybot-style.js:59-61`).
- [ ] Invalid color **falls back** to `db342e`; invalid size **clamps**; invalid type **filters**; none of them throw (`mybot-style.js:52-90`).
- [ ] `"none"` collapses a type list to `["none"]` (`mybot-style.js:86-88`).
- [ ] Per-builder color overrides match: authority/query/warning/failed force `db342e`; **complete keeps the profile color** (`chat-style.js:182`); processing `f7b503`; complete-request/tag `15a85f`; the `*Request`/tag builders also set `size.nameServer = 14` (`chat-style.js:403,430,457,484`).

### D. Mentions

- [ ] Mentions are force-emptied when `thread_type != Group` (`sendMessage.js:191-204`).
- [ ] Spans with `pos < 0 || uid == "" || len == 0` are dropped, not rejected (`sendMessage.js:194`).
- [ ] Wire `type` = `1` when `uid == "-1"` (accept both `-1` and `"-1"`), else `0` (`Message.js:35`; `sendMessage.js:201`).
- [ ] `Σ len > utf16(msg)` ⇒ error, not truncation (`sendMessage.js:205-207`).
- [ ] Field name on the wire is `mentionInfo` as a JSON **string** (`sendMessage.js:235,252`).
- [ ] `build_tag_message` shifts extra mentions by `utf16(sender_name) + 1` **only** — remove `icon_shift` (`v3_style.rs:743-762` vs `chat-style.js:487-494`).
- [ ] `@All`: `uid -1` with `len = utf16(body)`; non-admin fallback fans out one 1-unit space span per member with id = `member.split('_')[0]` (`chat-all.js:22-45`).

### E. Quote

- [ ] `quote` absent ⇒ no `qmsg*` params and endpoint suffix `/sendmsg`, `/mention` (if mentions) or `/sms` (DM) (`sendMessage.js:266-271`).
- [ ] `quote` present ⇒ `qmsgOwner/qmsgId/qmsgCliId/qmsgType/qmsgTs/qmsg/qmsgTTL` + suffix `/quote` (`sendMessage.js:229-248`).
- [ ] `qmsgType` map: `webchat→1`, `chat.voice→31`, `chat.photo→32`, `chat.sticker→36`, `chat.doodle→37`, `chat.recommended→38`, `chat.link→1`, `chat.video.msg→44`, `share.file→46`, `chat.gif→49`, `chat.location.new→43`, default `1` (`api-zalo/utils.js:450-462`).
- [ ] `msgType == "webchat"` with non-string content, and `msgType == "group.poll"`, are refused (`sendMessage.js:221-226`).
- [ ] Quoted-reply recognition keys on `quote.globalMsgId ?? quote.msgId`, with `cliMsgId` backfilled when the stored ref lacks it (`interaction-countdown.js:888-904`; `api-crawl/index.js:200-211`).
- [ ] Bot-origin detection is `uidFrom/ownerId == "0"` (`recent-message.js:19,61`).
- [ ] Recall requires **both** `msgId` and `cliMsgId` plus a valid `threadId`/`type` (`interaction-countdown.js:440-456`).

### F. Reaction & countdown

- [ ] `thanks` fires only for types `1,2,3,5` (`command-response.js:2`), after permission/cooldown, before dispatch (`command.js:986-999`).
- [ ] Dispatcher gate `[1,2,3] && (caller_admin || active_bot)` (`command.js:726-733`, `:986-992`).
- [ ] Reaction encoded `rIcon "/-thanks"`, `rType 111`, `source 6`; `clientId = Date.now() + index` (`addReaction.js:65-72`).
- [ ] `UNDO` is `rType -1` with empty `rIcon` (`Reaction.js:4`); `CLOCK` is `rType 55`, `"🕑"` (`Reaction.js:39`); `LIKE` 3, `HEART` 5 (`Reaction.js:8,10`).
- [ ] Countdown: `next = max(0, ceil((expires_at - now)/1000))`, tick every `1000 ms`, batched at **50**, frame = UNDO(current) + CLOCK(next) (`interaction-countdown.js:316,324-338,389-415,631,646`).
- [ ] Expiry: UNDO final frame → `onExpire` → `recallBotMessage` only when `deleteOnExpire` (`interaction-countdown.js:586-616`).
- [ ] `recallBotMessage` retries 2× at 300 ms linear, only on 408/429/≥500 (`interaction-countdown.js:417-421,467-493`).

### G. Numeric / transport parity

- [ ] `clientId = Date.now()` (13-digit epoch ms) on every message send, and it is the same value whose `String()` is echoed as `cliMsgId` in the response (`sendMessage.js:234,251,84-88`).
- [ ] Reaction ids are `parseInt` **numbers** on the wire (`addReaction.js:58-62`).
- [ ] `linkOn: false` on every styled payload (`mybot-style.js:198,256`), so the `sendLink` branch is never taken for styled replies (`sendMessage.js:549-557`).
- [ ] Retry ladder order: `full → no-quote → no-style → plain` (`chat-style.js:30-36`) **then** `original → no-quote → no-style → no-mentions → plain` (`sendMessage.js:467-474`).
- [ ] TTL resolution: explicit `ttl ||` `appContext.timeMessage ||` `0` — and `0 → 60000` **only** in `sendMessageStateQuote` (`chat-style.js:265`).

### H. Sanitization & splitting

- [ ] Markdown stripping is confined to the AI-reply body, removes `**` only, and runs **before** envelope rendering (`gemini.js:352`); the header name is never sanitized (fix `v3_style.rs:378-379` and the `pipeline.rs` call sites).
- [ ] Splitting: `!cmd` = 2000 chars, line-aware with hard-chunking of over-long lines (`help.js:369-399`); `!cmdadd list` = 3500 chars, line-aware, no hard-chunk (`cmdadd-command.js:237-252`).
- [ ] Only part 0 carries `quote` **and** `style` (`help.js:652-653,673`; `cmdadd-command.js:147`).
- [ ] `checkip`-style headers keep their raw `**`/`__` tokens (`checkip.js:22-24`).

### I. Regression vectors (build these as byte-equality tests)

All expected numbers below were **computed with Node**, not by hand:

```
"🤖 Thanh Hung".length           === 13   // 2 (🤖) + 1 (space) + 10 ("Thanh Hung")
"🤖 HHH ✅".length               === 8    // 2 (🤖) + 1 + 3 ("HHH") + 1 + 1... = 8 total
"Nguyễn".length                  === 6    // all letters precomposed → 1 unit each
"Nguyễn\n🤖 Thanh Hung".length   === 20   // 6 + 1 + 13
```

- [ ] Group, sender `Nguyễn`, bot name `Thanh Hung`, default style, `text = "abc"` ⇒
      `msg == "Nguyễn\n🤖 Thanh Hung\nabc"`, **1 span only**:
      `{"start":7,"len":13,"st":"b,c_db342e,f_18"}` (7 = `utf16("Nguyễn\n")`, 13 = `utf16(header)`).
      No text span, because `type.text == ["none"]` **and** `size.text == 14` (`mybot-style.js:234`).
- [ ] Same with `text = ""`, `state_icon = "🚨🚨🚨"` ⇒ `"Nguyễn\n🤖 Thanh Hung\n\n🚨🚨🚨"`, still 1 span.
- [ ] Same with `text = ""`, no state icon ⇒ `"Nguyễn\n🤖 Thanh Hung\n"` — **one trailing `"\n"`**
      (the D2 vector; `v3_style.rs:398-402` currently emits one byte fewer).
- [ ] Emoji header: `icon = "🤖"`, name server `"HHH ✅"` ⇒ `header == "🤖 HHH ✅"`, `header.len == 8`.
- [ ] `sendMessageTag`, group, one extra mention at `pos 5` ⇒ emitted `pos = 5 + utf16(sender_name) + 1`
      (V3 adds **no** icon term — `chat-style.js:492`); `v3_style.rs:756-759` wrongly also adds
      `utf16("🤖 ") == 3`, giving `pos + 3`.
- [ ] `utf16_len` vectors: `"a"`→1, `"ế"` (U+1EBF, precomposed)→1, `"ế"` as `"e"+U+0302+U+0301`→3,
      `"🤖"`→2, `"✅✅✅"`→6.
- [ ] `DEFAULT_STYLE.icon` costs 3 units in every header (`🤖` + the injected space) and 0 in the tag
      mention shift.
- [ ] D2 note for the `*Request`/tag builders: `text: ""` and no `state_icon`, so the body is `""` and
      only the header (which is `objectData.caption`) is visible — but the newline is still there.
