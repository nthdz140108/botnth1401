import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  getBangkokCalendarWeek,
  loadTrialLedger,
  saveTrialLedger,
  getOwnerTrialStatus,
  claimOwnerTrial,
  resetOwnerTrialForWeek,
} from "../src/commands/mybot/System/mybot-trial-ledger.js";

test("getBangkokCalendarWeek calculates ISO week based on Asia/Bangkok time (UTC+7)", () => {
  // 2026-08-24 is Monday in Bangkok
  const mondayBangkok = new Date("2026-08-24T00:00:00+07:00").getTime();
  const sundayBangkok = new Date("2026-08-30T23:59:59+07:00").getTime();
  const nextMondayBangkok = new Date("2026-08-31T00:00:00+07:00").getTime();

  const week1 = getBangkokCalendarWeek(mondayBangkok);
  const week1End = getBangkokCalendarWeek(sundayBangkok);
  const week2 = getBangkokCalendarWeek(nextMondayBangkok);

  assert.equal(week1, week1End);
  assert.notEqual(week1, week2);
  assert.match(week1, /^\d{4}-W\d{2}$/);
});

test("trial ledger allows only 1 trial per owner per Bangkok calendar week", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trial-ledger-test-"));
  const ledgerPath = path.join(tmpDir, "trial-ledger.json");

  try {
    const owner1 = "user_111";
    const bot1 = "bot_111";
    const now = new Date("2026-08-27T10:00:00+07:00").getTime();

    // 1. Initial status: eligible
    const initialStatus = getOwnerTrialStatus(owner1, { ledgerPath, now });
    assert.equal(initialStatus.eligible, true);
    assert.equal(initialStatus.record, null);

    // 2. Claim trial: success
    const claimRes1 = claimOwnerTrial(owner1, bot1, { durationMs: 3600000, ledgerPath, now });
    assert.equal(claimRes1.success, true);
    assert.equal(claimRes1.record.ownerUid, owner1);
    assert.equal(claimRes1.durationMs, 3600000);

    // 3. Status now: not eligible in same week
    const statusAfter = getOwnerTrialStatus(owner1, { ledgerPath, now });
    assert.equal(statusAfter.eligible, false);
    assert.ok(statusAfter.record);

    // 4. Duplicate claim in same week: rejected with TRIAL_QUOTA_EXHAUSTED
    const claimRes2 = claimOwnerTrial(owner1, bot1, { durationMs: 3600000, ledgerPath, now });
    assert.equal(claimRes2.success, false);
    assert.equal(claimRes2.code, "TRIAL_QUOTA_EXHAUSTED");

    // 5. Another owner can still claim in the same week
    const owner2 = "user_222";
    const claimResOwner2 = claimOwnerTrial(owner2, "bot_222", { durationMs: 3600000, ledgerPath, now });
    assert.equal(claimResOwner2.success, true);

    // 6. Next week in Bangkok: eligible again
    const nextWeekNow = now + 7 * 24 * 3600 * 1000;
    const nextWeekStatus = getOwnerTrialStatus(owner1, { ledgerPath, now: nextWeekNow });
    assert.equal(nextWeekStatus.eligible, true);

    const nextWeekClaim = claimOwnerTrial(owner1, bot1, { durationMs: 3600000, ledgerPath, now: nextWeekNow });
    assert.equal(nextWeekClaim.success, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
