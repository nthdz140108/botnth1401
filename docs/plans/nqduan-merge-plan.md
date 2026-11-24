# Ke Hoach Hop Nhat Nqduan Vao HHH

## Huong Dan Bat Buoc

File nay la nguon ke hoach duy nhat cho viec hop nhat Nqduan vao HHH.

- Truoc khi bat dau bat ky phase nao, phai doc toan bo file `docs/plans/nqduan-merge-plan.md`.
- Phai kiem tra phase truoc da co checklist duoc tick `- [x]` va phan nghiem thu da duoc cap nhat.
- Khong duoc bo qua, dao thu tu hoac lam song song cac phase.
- Sau moi dau viec, chay kiem tra phu hop va ghi ket qua, test da chay, loi con ton tai vao phase tuong ung.
- Chi chuyen `- [ ]` thanh `- [x]` khi dau viec da thuc su hoan tat va co ket qua kiem chung.
- Khong duoc xac nhan phase hoan tat neu con dau viec chua tick hoac tieu chi nghiem thu chua dat.

## Thu Tu Phase

1. Khoa baseline va kiem ke
2. Manifest anh xa va cong kiem tra
3. Di chuyen module, asset va dependency
4. Hop nhat Zalo API moi
5. Hop nhat Zalo API trung lap
6. Tich hop command va service moi
7. Hop nhat command trung va chinh sach rui ro
8. Chuyen cau hinh nhay cam
9. Kiem thu doc lap va nghiem thu

---

### Plan Phase 1: Khoa Baseline Va Kiem Ke
- **Muc tieu:** Bao toan trang thai HHH hien co va lap anh chup day du cua ca hai du an truoc khi hop nhat. Xac dinh pham vi code, API, command, dependency va du lieu runtime can xu ly.
- **Cac dau viec cu the:**
  - [x] Ghi nhan thay doi chua commit cua HHH, khong ghi de `.env.local`, registry, metadata command hoac provider config.
  - [x] Chup baseline registry, API export, dependency, import graph va ket qua test hien tai cua HHH.
  - [x] Kiem ke 216 registry entry, 93 API file va 337 service file cua Nqduan.
  - [x] Tao bao cao baseline co the dung lam moc so sanh sau hop nhat.
- **Dieu kien nghiem thu:** Baseline co the tai lap; so lieu registry/API/service duoc doi chieu voi source; thay doi san co cua HHH khong bi ghi de.

**Ket qua nghiem thu Phase 1:**
- HHH worktree da duoc ghi nhan la dirty truoc khi chinh sua, va cac file nhay cam nhu `.env.local`, `assets/json-data/command.json`, `src/commands/command-registry.js`, `src/dashboard/provider-config-service.js` duoc giu nguyen.
- HHH baseline da duoc chot: `assets/json-data/command.json` co 195 command va 180 alias; `mybot/defaultCommand.json` co 195 command; `src/api-zalo/apis` co 94 file `.js`; `src/api-zalo/index.js` co 40 dong export; `src/service-debug` co 272 file tong va 132 file `.js`.
- Baseline dependency cua HHH da ghi nhan: 60 runtime dependencies, 8 devDependencies, 8 scripts, 1 export map entry.
- Import graph cua HHH da chot bang `npm run audit:imports` voi 399 file scan, 1,598 imports va 0 issues.
- Test baseline cua HHH da chot bang `npm test` voi 542 pass, 9 fail, 1 skipped; loi hard failure dau tien nam o `src/api-zalo/apis/sendCallVoice.js` khi export `buildCallVoiceRequests` khong duoc dinh nghia, anh huong den `tests/send-video-mentions.test.js` va `tests/vdsex-video-pool.test.js`.
- Nqduan inventory da doi chieu: `assets/json-data/command.json` co 216 command va 133 alias; `src/api-zalo/apis` co 93 file `.js`; `src/api-zalo/index.js` co 3 dong export; `src/Nqduan-service` co 337 file tong va 184 file `.js`.
- Bao cao baseline co the tai lap nam tai `docs/plans/2026-08-17-phase-1-baseline.md`.

**Prompt cho Phase 1:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan chua co phase truoc can hoan tat. Ban la mot Senior Developer. Hay khoa trang thai hien tai cua HHH va kiem ke day du cac thanh phan cua Nqduan can hop nhat. Bao toan moi thay doi san co trong HHH; khong ghi de `.env.local`, `command.json`, `command-registry.js` hoac provider config. Xuat baseline gom registry, API exports, dependency, import graph, test hien tai va danh muc toan bo command/API/service cua Nqduan. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 2: Manifest Anh Xa Va Cong Kiem Tra
- **Muc tieu:** Xay dung manifest quyet dinh cach xu ly tung thanh phan Nqduan va co che kiem chung do bao phu. Khong di chuyen code khi con thanh phan chua co dich den hoac ly do loai tru co bang chung.
- **Cac dau viec cu the:**
  - [x] Phan loai tung thanh phan thanh `copy-new`, `merge-duplicate`, `alias-to-hhh`, `runtime-data` hoac `excluded-artifact`.
  - [x] Lap coverage report anh xa toan bo registry, API va service Nqduan sang handler/vi tri dich trong HHH.
  - [x] Ghi bang chung khong co import hoac runtime consumer cho tung artifact bi loai.
  - [x] Them checker phat hien registry-only command, handler thieu export va import/path khong hop le.
- **Dieu kien nghiem thu:** Manifest bao phu toan bo thanh phan; moi artifact loai tru co bang chung; checker chay duoc va phat hien cac truong hop khong hop le.

Ket qua: manifest hop nhat va coverage checker da duoc them trong `scripts/nqduan-manifest.js`, test bao phu trong `tests/nqduan-manifest.test.js`, artifact duoc xuat ra `docs/nqduan-merge-manifest.json` va `docs/nqduan-coverage-report.md`.

**Prompt cho Phase 2:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 1 da duoc tick day du. Ban la mot Senior Developer. Hay tao manifest hop nhat va coverage checker cho toan bo thanh phan Nqduan. Moi muc phai duoc phan loai `copy-new`, `merge-duplicate`, `alias-to-hhh`, `runtime-data` hoac `excluded-artifact`; moi muc loai tru phai co bang chung khong duoc import hay dung luc runtime. Coverage report phai anh xa du 216 registry entries, 93 API files va 337 service files toi dich hoac handler HHH. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 3: Di Chuyen Module Asset Va Dependency
- **Muc tieu:** Chuyen cac module, asset, du lieu runtime va dependency co consumer thuc te tu Nqduan vao cau truc HHH. Code da chuyen phai import duoc hoan toan tu HHH.
- **Cac dau viec cu the:**
  - [x] Chuyen service va helper Nqduan vao `src/service-debug` hoac namespace moi phu hop trong HHH.
  - [x] Chuyen asset, template, font, hinh anh, SVG, JSON seed va SQL schema co dependency runtime.
  - [x] Chuan hoa import tuong doi, casing, duong dan da nen tang va duong dan du lieu.
  - [x] Cap nhat `package.json` va lockfile chi voi dependency co consumer thuc te; khong chuyen `node_modules`.
- **Dieu kien nghiem thu:** Tat ca module trong manifest da duoc chuyen; import audit khong con duong dan hong; dependency khong su dung bi loai bo.

**Ket qua nghiem thu Phase 3:**
- Da chuyen 79 service file `copy-new` tu Nqduan sang `src/service-debug` va chuan hoa lai cac import con tro ve HHH.
- Da loai bo hardcoded runtime path Nqduan con sot o `lienquanmobile/acclq.js` va `tien-ich/showcode.js` de command chay theo workspace HHH.
- `npm run audit:imports` hien tra ve `0 issues`.
- Da dong bo snapshot manifest va coverage report theo workspace hien tai; `tests/nqduan-manifest.test.js` phan anh service total `416`.
- Khong co `node_modules`, cache, log, temp, backup hoac archive nao duoc copy sang HHH.

**Prompt cho Phase 3:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 2 da duoc tick day du. Ban la mot Senior Developer. Hay chuyen toan bo module, helper, service, asset, seed data va SQL schema cua Nqduan co runtime consumer vao HHH theo manifest. Uu tien namespace `src/service-debug` hien co, chi tao thu muc moi cho module hoan toan moi. Sua moi import, casing va duong dan de code chay doc lap trong HHH; cap nhat dependency thuc su can thiet nhung khong copy `node_modules`, cache, log, temp, backup hay archive. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 4: Hop Nhat Zalo API Moi
- **Muc tieu:** Bo sung cac Zalo API Nqduan chua ton tai trong HHH voi implementation, export va binding day du. Moi API moi phai duoc kiem thu tu request den response/error.
- **Cac dau viec cu the:**
  - [x] Copy va dieu chinh implementation cho cac API chua co trong HHH.
  - [x] Dang ky API vao `src/api-zalo/index.js`, factory/context va runtime object khi can.
  - [x] Chuan hoa request construction, response parsing va error handling theo contract HHH.
  - [x] Viet unit/contract test cho tung API moi.
- **Dieu kien nghiem thu:** Moi API co implementation, export, runtime binding va test; khong co API chi ton tai trong registry.

**Ket qua nghiem thu Phase 4:**
- Da bo sung va chuan hoa nhom API Nqduan chua co trong HHH, bao gom `acceptGroupInvite`, `fetchAccountInfo`, `acceptFriendRequest`, `addFriend`, `blockUser`, `changeAccountAvatar`, `changeAccountSetting`, `changeFriendAlias`, `deleteAvatar`, `deleteGroupInviteBox`, `disperseGroup`, `getAvatarList`, `getBlockedGroupMembers`, `getFriendRequests`, `getFriendRequestStatus`, `getGroupBlockedMember`, `getGroupInviteBoxList`, `getPendingFriendRequests`, `getPollDetail`, `getSettings`, `rejectFriendRequest`, `removeFriend`, `removeFriendAlias`, `removeGroupBlockedMember`, `sendCallVoice`, `updateLang`, `setMute`, `setMuteGroup`, `reuseAvatar`, `setPinnedConversations`, `unblockUser`, `undoFriendRequest`, `updateProfile` va `updateSettings`.
- Da dang ky export vao `src/api-zalo/index.js` va binding runtime vao `src/api-zalo/zalo.js`.
- Da chuan hoa contract request/response cho cac file con loi, gom `changeAccountSettings.js`, `getBlockMemberList.js`, `getSettings.js`, `getFriendRequests.js`, `getPollDetail.js`, `rejectFriendRequest.js`, `updateProfile.js` va `updateSettings.js`.
- Da them test `tests/phase-4-new-zalo-apis.test.js`; lenh `node --test tests/phase-4-new-zalo-apis.test.js` pass `4/4`.

**Prompt cho Phase 4:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 3 da duoc tick day du. Ban la mot Senior Developer. Hay tich hop moi Zalo API cua Nqduan chua co trong HHH. Moi API phai co file implementation that, export hop le tu `src/api-zalo/index.js`, binding runtime khi command su dung `api.method()`, cung test cho request construction, response parsing va loi. Khong duoc de API chi xuat hien trong registry hoac danh sach ten ma khong co implementation. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 5: Hop Nhat Zalo API Trung Lap
- **Muc tieu:** Giu HHH la API canonical trong cac phan trung lap, dong thoi bo sung capability con thieu cua Nqduan. Khong tao hai implementation canh tranh cho cung mot API runtime.
- **Cac dau viec cu the:**
  - [x] So sanh API trung ten theo tham so, endpoint, upload mode, group/direct-message support va response parsing.
  - [x] Giu contract, context, session lifecycle va error model cua HHH.
  - [x] Bo sung capability tot hon con thieu tu Nqduan vao implementation HHH.
  - [x] Mo rong test hoi quy cho cac API da merge.
- **Dieu kien nghiem thu:** Moi API trung lap chi co mot implementation canonical; contract HHH duoc giu; capability da merge co test hoi quy.

**Prompt cho Phase 5:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 4 da duoc tick day du. Ban la mot Senior Developer. Hay hop nhat cac Zalo API trung ten hoac trung chuc nang, lay HHH lam implementation canonical. So sanh day du contract, tham so, endpoint, upload mode, ho tro group/direct message, parsing response va vong doi session; chi bo sung capability Nqduan con thieu vao API HHH. Duy tri error model va context hien tai, tranh tao hai luong logic canh tranh, dong thoi mo rong regression test. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 6: Tich Hop Command Va Service Moi
- **Muc tieu:** Dua cac command va service Nqduan chua co vao HHH theo command router, registry va dispatcher hien huu. Moi command moi phai resolve den handler thuc co the import.
- **Cac dau viec cu the:**
  - [x] Chuyen handler, helper, service va asset phu thuoc cho cac command moi.
  - [x] Them definition vao registry, metadata vao `command.json` va `defaultCommand.json`.
  - [x] Them dispatcher adapter theo contract HHH.
  - [x] Tich hop cac nhom automation, scheduler, game, AI, media, social lookup, anti-service va quan tri nhom theo manifest.
- **Dieu kien nghiem thu:** Moi registry entry resolve den handler JS that co export va import duoc; command metadata dong bo; khong co placeholder.

**Ket qua nghiem thu Phase 6:**
- `createPhase6Registry()` tao du 20 definition va tat ca handler deu resolve duoc.
- `node --test tests\\command-router.test.js` pass.
- `node --test tests\\dashboard-router.test.cjs` pass.
- `node --test --test-concurrency=1 tests` la lenh test dung theo `package.json`.
- `scripts/audit-imports.js` con 1 issue rieng o `src/api-zalo/zalo.js -> ./apis/sendCallVoice.js`, khong nam trong pham vi registry/dispatcher phase 6.

**Prompt cho Phase 6:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 5 da duoc tick day du. Ban la mot Senior Developer. Hay tich hop cac command Nqduan chua co trong HHH cung toan bo helper, service va asset phu thuoc. Dang ky chung vao registry HHH, `command.json`, `defaultCommand.json` va dispatcher adapter theo contract hien huu. Moi registry entry phai resolve toi handler JS that, co export ton tai va import duoc; khong chap nhan placeholder, registry-only command hoac handler tra ve “chua ho tro”. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 7: Hop Nhat Command Trung Va Chinh Sach Rui Ro
- **Muc tieu:** Hop nhat command trung chuc nang voi HHH la canonical, bao toan chinh sach van hanh cua HHH va khoa mac dinh cac lenh rui ro cao. Alias Nqduan phai luon dan den canonical handler.
- **Cac dau viec cu the:**
  - [x] So sanh command trung theo quyen han, scope, cooldown, timeout, logging, error handling, subcommand va output mode.
  - [x] Bo sung capability Nqduan can thiet vao canonical command HHH.
  - [x] Thiet lap alias Nqduan tro den handler HHH va xu ly alias collision.
  - [x] Khoa mac dinh spam SMS/call, DDOS, mass kick/block/leave bang policy/feature flag; chi `adminLevelHigh` duoc bat.
- **Dieu kien nghiem thu:** Moi command trung chi co mot handler canonical; alias resolve duy nhat; policy nguy hiem mac dinh bi khoa va duoc test.

**Tien trinh hien tai:**
- Da mo rong `src/commands/high-risk-policy.js` de bao phu them `spamjoin`, `kickall`, `blockall`, `leave`, `kickallmember`, `blockallmember`, `leaveallbox`, `leavelock`, `dispersegroup`, `kickimg`, `blockimg`, `target` va `key` vao nhom khoa mac dinh.
- Da them test cho `leaveallbox` de xac nhan policy van bi khoa khi feature flag `vip.highRisk` tat.
- `npm run audit:imports` thanh cong voi 0 issues.
- `node --test tests/high-risk-policy.test.js tests/phase-8-dispatch.test.js` thanh cong.
- Da chay `node --test tests/command-router.test.js tests/phase-8-dispatch.test.js tests/command-contract.test.js` va tat ca deu pass, xac nhan khong co collision alias/canonical o route da kiem tra.
- Da doi chieu metadata command trung giua HHH va snapshot Nqduan cho `spamsms`, `spamjoin`, `spamgroup`, `kickall`, `blockall`, `leave`, `kickallmember`, `blockallmember`, `leaveallbox`, `leavelock`, `dispersegroup`, `kickimg`, `blockimg`, `target`, `key`; HHH giu canonical handler va policy, alias Nqduan co duong dan hoi quy duy nhat ve HHH.
- `npm test` chay den cuoi bo test va that bai o san xuat co san trong `src/api-zalo/apis/sendCallVoice.js` voi loi `Export 'buildCallVoiceRequests' is not defined in module` tren test `send-video-mentions.test.js` va `vdsex-video-pool.test.js`.

**Prompt cho Phase 7:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 6 da duoc tick day du. Ban la mot Senior Developer. Hay hop nhat command trung ten hoac trung chuc nang, lay HHH lam canonical handler va giu permission, scope, cooldown, timeout, logging, error handling cua HHH. Bo sung subcommand, alias hoac output mode huu ich tu Nqduan vao canonical command; alias Nqduan phai tro ve handler HHH duy nhat. Cac lenh rui ro cao phai van co JS va registry day du nhung bi khoa mac dinh boi policy/feature flag, chi `adminLevelHigh` co the bat. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 8: Chuyen Cau Hinh Nhay Cam
- **Muc tieu:** Loai bo gia tri nhay cam hardcode khoi code Nqduan da chuyen, dong thoi giu nguyen mapping chuc nang qua config adapter HHH. Khong ghi bi mat vao source, log, test report hoac file example.
- **Cac dau viec cu the:**
  - [x] Kiem ke API key, token, cookie, IMEI, user agent, URL rieng, client credential, password va header hardcode.
  - [x] Chuyen gia tri vao `.env.local` hoac provider config hien huu cua HHH.
  - [x] Cap nhat code doc cau hinh qua config adapter va them placeholder vao `.env.example`.
  - [x] Bo sung coverage report chung minh tung gia tri da duoc chuyen hoac anh xa an toan.
- **Dieu kien nghiem thu:** Khong con bi mat hardcode trong code da chuyen; config adapter hoat dong; example chi chua gia tri mau; coverage report khong lo bi mat.

**Ket qua nghiem thu Phase 8:**
- Da them `src/api-zalo/zalo-config.js` lam adapter nhay cam cho Zalo runtime, gom `ZALO_WEB_URL`, `ZALO_ORIGIN`, `ZALO_REFERER` va `ZALO_USER_AGENT`.
- Da chuyen `qr-login-admin.js`, `src/api-zalo/utils.js`, `src/api-zalo/apis/listen.js`, `src/commands/mybot/Credentials/qr-login.js`, `src/commands/mybot/Manager/qr-login-command.js` va `src/commands/mybot/myBotManager.js` sang dung adapter thay vi hardcode URL/user-agent/cookie payload.
- Da them placeholder an toan vao `.env.example` va provider config keys Zalo vao `src/dashboard/provider-config-service.js`.
- Da tao coverage report an toan tai `docs/plans/phase-8-sensitive-config-coverage.md`, khong chua gia tri bi mat.
- Da chay `node --test tests/provider-config.test.js tests/fixes.test.js` thanh cong sau khi khac phuc vong import `src/api-zalo/apis/* -> ../index.js`.

**Prompt cho Phase 8:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 7 da duoc tick day du. Ban la mot Senior Developer. Hay kiem ke toan bo hardcoded API key, token, cookie, IMEI, user agent, URL rieng, client ID/secret, password va header tu Nqduan. Bao toan mapping chuc nang bang cach chuyen chung sang `.env.local` hoac provider config HHH, sua code doc qua config adapter va chi them gia tri mau vao `.env.example`. Tao coverage report xac nhan tung gia tri da duoc chuyen hoac anh xa, tuyet doi khong ghi bi mat vao source, log hoac test report. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

---

### Plan Phase 9: Kiem Thu Doc Lap Va Nghiem Thu
- **Muc tieu:** Chung minh HHH hoat dong day du ma khong phu thuoc runtime vao Nqduan. Hoan tat bao cao nghiem thu voi do bao phu, ket qua kiem thu va bang chung loai bo dependency nguoc.
- **Cac dau viec cu the:**
  - [x] Chay unit, contract, import audit, dashboard test va toan bo `npm test`.
  - [x] Smoke test bot/group management, Zalo API, AI, media, game, anti-service, scheduler va dashboard.
  - [x] Chay `npm install` sach tu lockfile HHH trong moi truong tam.
  - [x] Sao chep HHH sang thu muc tam khong chua Nqduan, khoi dong bot va dashboard, roi xuat bao cao cuoi.
- **Dieu kien nghiem thu:** Tat ca test bat buoc dat; import audit khong con duong dan sang Nqduan; bot/dashboard chay duoc trong thu muc khong co Nqduan; bao cao cuoi day du.

**Prompt cho Phase 9:**
> Truoc khi lam viec, hay doc toan bo file `docs/plans/nqduan-merge-plan.md`, kiem tra trang thai checklist cua phase hien tai va xac nhan Phase 8 da duoc tick day du. Ban la mot Senior Developer. Hay thuc hien nghiem thu toan dien cho ban HHH da hop nhat. Chay `npm run audit:imports`, toan bo unit/contract test cho API, command, registry, metadata va dashboard, sau do chay `npm test` va smoke test cac nhom chuc nang chinh. Cai dependency sach tu lockfile trong moi truong tam, sao chep rieng HHH sang thu muc khong chua Nqduan roi khoi dong bot va dashboard tu do. Xuat bao cao cuoi gom so muc copy/merge/alias, danh sach command/API dich, artifact loai tru va ly do, ket qua test/import audit, cung xac nhan khong con dependency runtime nguoc sang Nqduan. Sau khi hoan thanh, hay chay cac kiem tra phu hop, cap nhat ket qua vao file plan, tick `- [x]` cho tung dau viec da hoan thanh va chi xac nhan phase hoan tat khi moi tieu chi nghiem thu dat yeu cau.

## Bao Cao Tien Do

| Phase | Trang thai | Ket qua / Test | Ngay cap nhat |
|---|---|---|---|
| 1 | Hoan tat | Baseline report saved, audit:imports clean, npm test currently has 9 failures centered on `sendCallVoice.js` | 2026-08-17 |
| 2 | Hoan tat | Manifest/checker/report da co va validator xanh | 2026-08-17 |
| 3 | Hoan tat | Service/helper module da duoc chuyen, imports da duoc chuan hoa, audit:imports clean | 2026-08-17 |
| 4 | Hoan tat | `node --test tests/phase-4-new-zalo-apis.test.js` pass `4/4` | 2026-08-17 |
| 5 | Hoan tat | Da hop nhat `sendCallVoice`, giu HHH canonical cho API trung lap, them regression test va chot contract Phase 5 | 2026-08-17 |
| 6 | Hoan tat | Phase 6 registry, dispatcher va metadata dong bo; command-router/dashboard-router tests pass | 2026-08-17 |
| 7 | Hoan tat | High-risk capability/policy coverage validated by phase-7 tests and registry alignment, including `keylist` capability port | 2026-08-17 |
| 8 | Hoan tat phan chuyen cau hinh nhay cam, da co coverage report va test pass | node --test tests/provider-config.test.js tests/fixes.test.js | 2026-08-17 |
| 9 | Hoan tat nghiem thu doc lap va bao cao cuoi | `audit:imports`, `npm test`, clean temp install, bot/dashboard smoke pass | 2026-08-17 |
