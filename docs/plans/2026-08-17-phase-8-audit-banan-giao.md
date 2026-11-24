# Phase 8 Audit va Ban Giao

Ngay lap: 2026-08-17

## Pham vi

Bao cao nay ghi nhan ket qua audit cuoi cho muc tieu Phase 8:

- moi game public co handler/route/help/scope hop le
- khong con asset render thieu hoac path Nqduan hard-code trong runtime da kiem tra
- khong con am tien, mat tien, payout lap hoac state treo trong cac luong da test
- co bang chung ve output render va don file tam
- co the truy vet test/report/residual risk

## Ket qua kiem tra

- `src/commands/command-registry.js` dang tao command registry tap trung cho 10 phase, va `help` / `game` / `command` / `listCommands` deu co handler thuc.
- `src/commands/instructions/help.js` van la nguon help cho `help`, `game` va `command`.
- `src/service-debug/game-service/mini-game/caro.js` va `src/service-debug/game-service/co-tuong/co-tuong.js` co state machine, cleanup va ket thuc game ranh gioi ro rang.
- `src/service-debug/game-service/nong-trai/nong-trai.js` va `src/service-debug/game-service/fishing/fishing.js` co help command, guard `activeGame`, va flow game co cleanup/timeout doc lap.
- Tim kiem runtime cho `Nqduan` / `src/Nqduan` trong `src`, `tests`, `assets` va `dashboard` cho thay phan lon ket qua la test/report/doc, khong phai runtime route.

## Kiem thu da chay

- `node --test tests\command-contract.test.js tests\command-router.test.js tests\phase-8-contract.test.js tests\phase-8-dispatch.test.js tests\phase-9-contract.test.js tests\phase-9-dispatch.test.js tests\nqduan-manifest.test.js tests\audit-imports.test.js`
- `npm run audit:imports` khong chay duoc trong worktree nay vi khong co `package.json` / npm scripts tuong ung.
- `npm run doctor` khong chay duoc trong worktree nay vi khong co `package.json` / npm scripts tuong ung.

### Ket qua thuc te cua `node --test`

- Pass: `command-router.test.js`
- Pass: `audit-imports.test.js`
- Fail truoc import runtime: `command-contract.test.js`, `nqduan-manifest.test.js`, `phase-8-contract.test.js`, `phase-8-dispatch.test.js`, `phase-9-contract.test.js`, `phase-9-dispatch.test.js`
- Nguyen nhan chung: `ERR_MODULE_NOT_FOUND` cho package `lunar-calendar` khi import `src/commands/lich-command.js`

## Ket luan audit

- Khong tim thay bang chung moi ve runtime path `src/Nqduan` hard-code trong pham vi kiem tra nhanh nay.
- Khong tim thay bang chung moi ve asset render thieu trong cac file da thu khoi dong, nhung test render day du chua the chay den cuoi do dependency thieu.
- Co mot blocker ngoai Phase 8: dependency `lunar-calendar` dang thieu, lam cac test co import `src/commands/lich-command.js` fail truoc khi vao logic command/game.

## Residual Risk

1. Can cai dat/khac phuc dependency `lunar-calendar` truoc khi co the xac nhan pass day du bo test Phase 8/9.
2. Cac command/game runtime lien quan den `lich-command.js` chua duoc hop le hoa end-to-end trong lan chay nay vi loi import sá»›m.
3. Do khong co `package.json` trong worktree nay, khong the xac nhan `npm test`, `npm run audit:imports`, `npm run doctor` bang script chuan cua repo.

## Cap Nhat 2026-08-17

- `node --test tests\\anti-all-command.test.js tests\\anti-bot-command.test.js tests\\anti-command-persistence.test.js` pass sau khi chot `SKIP_ENV_VALIDATION` cho subprocess test va cat bo import-chain bootstrap qua `anti-all`.
- `node --test tests\\phase-6-dispatch.test.js tests\\phase-8-dispatch.test.js tests\\phase-9-dispatch.test.js` pass sau khi registry ve 241 canonical commands.
- `node --test --test-concurrency=1 tests` chua hoan tat trong lan chay nay; lan chay dai da timeout truoc khi co ket qua toan bo.

