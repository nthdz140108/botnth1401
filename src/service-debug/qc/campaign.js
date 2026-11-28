import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRoster, completeRoster } from '../info-service/roster-service.js';

const ACTIVE = new Set(['selecting', 'content', 'preparing', 'queued', 'scanning', 'sending', 'stopping']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class QcCheckpoint {
  constructor(file) {
    this.file = file;
    this.state = null;
    if (!fs.existsSync(file)) return;
    try {
      this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const state = this.state;
      const statuses = new Set([...ACTIVE, 'interrupted', 'expired', 'completed', 'stopped', 'session_lost', 'send_timeout', 'delivery_blocked', 'rate_limited']);
      if (state.version !== 1 || !Array.isArray(state.recipients) || typeof state.actor !== 'string'
        || !state.chat || typeof state.chat.threadId !== 'string' || ![0, 1].includes(state.chat.type)
        || !Array.isArray(state.groups) || !Array.isArray(state.scans) || !statuses.has(state.status)
        || !Number.isFinite(state.startedAt) || typeof state.stopRequested !== 'boolean'
        || state.recipients.some((r) => !r || !/^[1-9]\d*$/.test(r.uid) || !['pending','inflight','success','failed','unconfirmed'].includes(r.status))) throw new Error('schema');
    } catch { throw new Error('QC checkpoint không đọc được; cần kiểm tra trước khi tạo lượt mới.'); }
    if (ACTIVE.has(this.state.status)) {
      this.state.status = 'interrupted';
      this.state.endedAt = Date.now();
      for (const recipient of this.state.recipients) if (recipient.status === 'inflight') recipient.status = 'unconfirmed';
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }

  begin({ actor, chat, groups = [], status = 'queued' }) {
    this.state = { version: 1, id: randomUUID(), actor, chat, groups, status, startedAt: Date.now(), recipients: [], scans: [], stopRequested: false };
    this.save();
    return this.state;
  }

  requestStop() {
    if (!this.state || !ACTIVE.has(this.state.status)) return false;
    this.state.stopRequested = true;
    this.save();
    return true;
  }
}

function hasError(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.error || value.success === false || (value.error_code != null && Number(value.error_code) !== 0)
    || (value.errorCode != null && Number(value.errorCode) !== 0)) return true;
  return Object.values(value).some((entry) => entry && typeof entry === 'object' && hasError(entry));
}

export function classifyQcReceipt(value) {
  if (hasError(value)) return 'failed';
  if (!value || typeof value !== 'object') return 'unconfirmed';
  const ack = (id) => id != null && String(id).trim() !== '' && String(id) !== '0' && String(id) !== '-1';
  if (ack(value.msgId) || ack(value.messageId)) return 'success';
  const children = Array.isArray(value) ? value : ['message', 'attachment', 'link', 'data', 'results'].map((key) => value[key]).filter((v) => v != null && (!Array.isArray(v) || v.length));
  if (children.length && children.every((entry) => classifyQcReceipt(entry) === 'success')) return 'success';
  return 'unconfirmed';
}

export function qcSummary(state) {
  const recipients = state?.recipients || [];
  return {
    ...state, total: recipients.length,
    success: recipients.filter((r) => r.status === 'success').length,
    failed: recipients.filter((r) => r.status === 'failed').length,
    unconfirmed: recipients.filter((r) => r.status === 'unconfirmed' || r.status === 'inflight').length,
    unsent: recipients.filter((r) => r.status === 'pending').length,
    elapsedSeconds: Math.max(0, Math.round(((state?.endedAt || Date.now()) - (state?.startedAt || Date.now())) / 1000)),
  };
}

export function qcReport(state) {
  const s = qcSummary(state);
  const errors = new Map();
  for (const r of s.recipients || []) {
    if (r.errorCode) errors.set(r.errorCode, (errors.get(r.errorCode) || 0) + 1);
  }
  const reasons = [...errors].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([code, count]) => `Mã ${code}: ${count} người`);
  const explanation = s.status === 'delivery_blocked'
    ? '\nĐã dừng: Zalo liên tiếp từ chối nhận tin riêng (123/126/127). Quét được UID nhóm không đồng nghĩa được phép nhắn riêng; cần kiểm tra quyền nhận tin hoặc hạn chế tài khoản trên Zalo.'
    : s.status === 'rate_limited' ? '\nĐã dừng: Zalo giới hạn gửi tin (429). Chờ tài khoản hết giới hạn trước khi tạo lượt mới.' : '';
  const scans = (s.scans || []).filter((scan) => scan.completeness !== 'full').map((scan) =>
    `${scan.name}: ${scan.completeness === 'error' ? 'quét lỗi' : `${scan.count}/${scan.total ?? '?'} UID, ${scan.paginationError ? 'lỗi phân trang; ' : ''}${scan.completeness === 'unknown' ? 'chưa xác định đầy đủ' : 'chưa đầy đủ'}`}`);
  return `📣 QC: ${s.status}\nNgười nhận duy nhất: ${s.total}\nThành công: ${s.success}\nThất bại: ${s.failed}\nChưa xác nhận: ${s.unconfirmed}\nChưa gửi: ${s.unsent}\nThời gian: ${s.elapsedSeconds} giây${reasons.length ? `\nLỗi gửi:\n${reasons.join('\n')}` : ''}${explanation}${scans.length ? `\nQuét nhóm:\n${scans.join('\n')}` : ''}`;
}

function receiptError(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.error && typeof value.error === 'object') return value.error;
  if ((value.error_code != null && Number(value.error_code) !== 0)
    || (value.errorCode != null && Number(value.errorCode) !== 0)) return value;
  for (const child of Object.values(value)) {
    const error = receiptError(child);
    if (error) return error;
  }
  return null;
}

export function isQcSessionLost(error) {
  return Number(error?.status) === 401 || Number(error?.code) === 401 || error?.code === 'SESSION_EXPIRED'
    || /(?:session|login|phiên đăng nhập).*(?:expired|invalid|lost|hết hạn|không hợp lệ)|missing required app context|not logged in/i.test(error?.message || '');
}

function classifyError(error) {
  // Network and timeout errors may happen after the server accepted a message.
  const code = Number(error?.code);
  const status = Number(error?.status);
  if (['HTTP_REQUEST_FAILED','INVALID_JSON','INVALID_CONTENT_TYPE','DECRYPT_FAILED','EMPTY_RESPONSE_BODY'].includes(error?.code)
    || (status >= 500 && status < 600) || (code >= 500 && code < 600 && !error?.status) || error?.name === 'AbortError') return 'unconfirmed';
  if (error?.name === 'ZaloApiError' && Number.isFinite(code) && error.code != null) return 'failed';
  if (Number(error?.status ?? error?.code) >= 400 && Number(error?.status ?? error?.code) < 500) return 'failed';
  return 'unconfirmed';
}

export async function runQcCampaign({ api, store, groups, actor, chat, content, notify, sendTimeoutMs = 30000 }) {
  const state = store.state?.status === 'queued' ? store.state : store.begin({ actor, chat, groups });
  let lateSend = null;
  let reportSent = false;
  try {
    state.status = 'scanning'; store.save();
    const uids = new Set();
    const own = String(api.getOwnId());
    for (const group of groups) {
      if (state.stopRequested) break;
      try {
        const roster = readRoster(await api.getGroupInfo(group.id), group.id);
        let paginationError = false;
        await completeRoster(api, group.id, roster, { onError(error) {
          if (isQcSessionLost(error)) throw error;
          paginationError = true;
        } });
        for (const { uid } of roster.members) if (uid !== own) uids.add(uid);
        state.scans.push({ id: group.id, name: group.name, count: roster.members.length, total: roster.total,
          paginationError,
          completeness: roster.total === null ? 'unknown' : !paginationError && roster.total === roster.members.length && !roster.hasMore ? 'full' : 'partial' });
      } catch (error) {
        state.scans.push({ id: group.id, name: group.name, completeness: 'error' });
        if (isQcSessionLost(error)) { state.status = 'session_lost'; state.stopRequested = true; }
      }
      store.save();
    }
    state.recipients = [...uids].map((uid) => ({ uid, status: 'pending' }));
    store.save();
    if (!state.stopRequested && state.recipients.length) {
      // Failure to notify the origin must prevent an unannounced campaign.
      await notify(`📣 Bắt đầu gửi quảng cáo tới ${uids.size} thành viên duy nhất thuộc ${groups.length} nhóm: ${groups.map((g) => g.name).join(', ')}.`);
      state.status = 'sending'; store.save();
      let lastFinished = null;
      let consecutiveRefusals = 0;
      for (const recipient of state.recipients) {
        if (state.stopRequested) break;
        if (lastFinished !== null) await sleep(Math.max(0, 1000 - (Date.now() - lastFinished)));
        if (state.stopRequested) break;
        recipient.status = 'inflight'; store.save();
        let timer;
        const pending = Promise.resolve().then(() => content.send(recipient.uid));
        // Attach a rejection handler even when the deadline wins.
        const settled = pending.then((receipt) => ({ receipt }), (error) => ({ error }));
        const result = await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), sendTimeoutMs); })]);
        clearTimeout(timer);
        const error = result.error || receiptError(result.receipt);
        if (error) {
          const code = error.code ?? error.error_code ?? error.errorCode;
          // Store bounded diagnostics only, never payloads, URLs or credentials.
          if (code != null) recipient.errorCode = String(code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
          if (error.status != null) recipient.httpStatus = Number(error.status) || null;
        }
        if (result.timedOut) {
          recipient.status = 'unconfirmed'; state.status = 'send_timeout'; state.stopRequested = true;
          lateSend = settled;
        } else if (result.error) {
          recipient.status = classifyError(result.error);
          if (isQcSessionLost(result.error)) { state.status = 'session_lost'; state.stopRequested = true; }
        } else {
          recipient.status = classifyQcReceipt(result.receipt);
          if (isQcSessionLost(error)) { state.status = 'session_lost'; state.stopRequested = true; }
        }
        consecutiveRefusals = recipient.status === 'failed' && ['123', '126', '127'].includes(recipient.errorCode)
          ? consecutiveRefusals + 1 : 0;
        if (!state.stopRequested && (Number(error?.status) === 429 || recipient.errorCode === '429')) {
          state.status = 'rate_limited'; state.stopRequested = true;
        } else if (!state.stopRequested && consecutiveRefusals >= 5) {
          state.status = 'delivery_blocked'; state.stopRequested = true;
        }
        lastFinished = Date.now(); store.save();
      }
    }
    if (!['session_lost', 'send_timeout', 'delivery_blocked', 'rate_limited'].includes(state.status)) state.status = state.stopRequested ? 'stopped' : 'completed';
    state.endedAt = Date.now(); store.save();
    // Reporting is separate from the settled transport outcome.
    reportSent = true;
    await notify(qcReport(state)).catch(() => {});
    return qcSummary(state);
  } catch {
    // Includes persistence failure: never send to another UID after this point.
    state.status = 'interrupted'; state.endedAt = Date.now();
    for (const r of state.recipients) if (r.status === 'inflight') r.status = 'unconfirmed';
    try { store.save(); } catch { /* durable predecessor remains conservative */ }
    if (!reportSent) await notify(qcReport(state)).catch(() => {});
    return qcSummary(state);
  } finally {
    // A timeout is ambiguous: retain the bot lock and media until the old
    // transport settles. Starting another campaign could overlap the late send.
    if (lateSend) await lateSend;
    await content.cleanup();
  }
}
