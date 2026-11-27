import { QcCheckpoint, qcReport, runQcCampaign } from './campaign.js';
import { parseCommandContent } from '../../commands/command-parser.js';

const STEP_MS = 5 * 60_000;
const waitDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function qcMessageIds(receipt) {
  if (!receipt || typeof receipt !== 'object') return [];
  const ids = ['msgId', 'messageId', 'cliMsgId', 'clientId'].map((key) => receipt[key]).filter((v) => v != null && String(v) !== '0').map(String);
  for (const value of Object.values(receipt)) if (value && typeof value === 'object') ids.push(...qcMessageIds(value));
  return [...new Set(ids)];
}

function quotedIds(message) {
  const quote = message.data?.quote;
  return quote ? [quote.globalMsgId, quote.msgId, quote.cliMsgId, quote.clientId].filter((v) => v != null).map(String) : [];
}

export function qcIsHigh(context) {
  const auth = context.authorizationSnapshot || context.authorization;
  return Boolean(auth ? auth.isAdminLevelHigh || auth.isMainBotAdmin || auth.role === 'adminLevelHigh'
    : context.permissionLevel === 'adminLevelHigh' || context.isAdminLevelHighest === true);
}

export class QcSession {
  constructor({ api, store, checkpointFile, broker, prepare, now = () => Date.now(), wait = waitDefault }) {
    this.api = api;
    this.store = store || new QcCheckpoint(checkpointFile);
    this.broker = broker;
    this.prepare = prepare;
    this.now = now;
    this.wait = wait;
    this.session = null;
  }

  async notify(chat, msg) {
    // Bound reports and names as well as the initial list to Zalo's text budget.
    const receipts = [];
    const lines = String(msg).split('\n');
    let page = '';
    for (const line of lines) {
      for (let i = 0; i < Math.max(1, line.length); i += 2800) {
        const part = line.slice(i, i + 2800);
        if (page && page.length + part.length + 1 > 2900) {
          receipts.push(await this.api.sendMessage({ msg: page, strict: true, linkOn: false }, chat.threadId, chat.type));
          await this.wait(1000); page = '';
        }
        page += `${page ? '\n' : ''}${part}`;
      }
    }
    if (page) receipts.push(await this.api.sendMessage({ msg: page, strict: true, linkOn: false }, chat.threadId, chat.type));
    return receipts;
  }

  owns(context, state = this.session) {
    return state && String(context.message.data.uidFrom) === state.actor
      && String(context.message.threadId) === state.chat.threadId && context.message.type === state.chat.type;
  }

  async expire() {
    const s = this.session;
    if (!s || !['selecting', 'content'].includes(s.phase) || this.now() < s.expiresAt) return false;
    this.session = null;
    this.store.state.status = 'expired'; this.store.state.endedAt = this.now(); this.store.save();
    await this.notify(s.chat, '⏳ Phiên QC đã hết hạn 5 phút. Gọi lại lệnh qc để bắt đầu.');
    return true;
  }

  async command(context) {
    if (!qcIsHigh(context)) return 'denied';
    const message = context.message;
    const chat = { threadId: String(message.threadId), type: message.type };
    const actor = String(message.data.uidFrom);
    const action = String(context.args?.[0] || '').toLowerCase();
    await this.expire();
    const s = this.session;
    if (action === 'status' || action === 'stop') {
      const state = s || this.store.state;
      if (!state || !this.owns(context, state)) { await this.notify(chat, 'Không có phiên QC của bạn tại cuộc chat này.'); return 'not_owner'; }
      if (action === 'status') {
        await this.notify(chat, qcReport(this.store.state)); return 'status';
      }
      if (s) {
        this.store.requestStop();
        if (['loading', 'selecting', 'choosing', 'content'].includes(s.phase)) {
          this.session = null; this.store.state.status = 'stopped'; this.store.state.endedAt = this.now(); this.store.save();
        }
      }
      await this.notify(chat, '🛑 Đã yêu cầu dừng QC. Không gửi tới người tiếp theo; tin đang gửi có thể hoàn tất.');
      return 'stopped';
    }
    if (action) { await this.notify(chat, 'Dùng qc, qc status hoặc qc stop.'); return 'usage'; }
    if (this.session) { await this.notify(chat, 'Bot đang có phiên QC hoạt động. Người khởi tạo dùng qc status hoặc qc stop.'); return 'busy'; }
    const current = { actor, chat, phase: 'loading', listIds: [], promptIds: [], groups: [], selected: [], seen: new Set() };
    this.session = current;
    try {
      this.store.begin({ actor, chat, status: 'selecting' });
      const response = await this.api.getAllGroups();
      if (this.session !== current) return 'stopped';
      if (!response?.gridVerMap || typeof response.gridVerMap !== 'object' || Array.isArray(response.gridVerMap)) throw new Error('group list');
      for (const id of Object.keys(response.gridVerMap)) {
        if (this.session !== current) return 'stopped';
        let info;
        try { const result = await this.api.getGroupInfo(id); info = result?.gridInfoMap?.[id] || result; } catch { /* preserve this group's slot even if metadata is unavailable */ }
        if (this.session !== current) return 'stopped';
        current.groups.push({ id, name: String(info?.name || id).replace(/\s+/g, ' ').slice(0, 160), total: Number.isSafeInteger(Number(info?.totalMember)) && info?.totalMember != null ? Number(info.totalMember) : '?' });
      }
      if (!current.groups.length) {
        this.session = null; this.store.state.status = 'completed'; this.store.save();
        await this.notify(chat, 'Bot chưa tham gia nhóm nào.'); return 'empty';
      }
      let page = [];
      const flush = async () => {
        if (this.session !== current) return;
        const receipts = await this.notify(chat, `📣 QC — reply tin danh sách với 1, 1 2 3 hoặc all (5 phút).\n${page.join('\n')}`);
        current.listIds.push(...receipts.flatMap(qcMessageIds)); page = [];
      };
      for (const [i, group] of current.groups.entries()) {
        const line = `${i + 1}. ${group.name} (${group.total} thành viên)`;
        if (page.length >= 20 || page.join('\n').length + line.length > 2600) {
          await flush(); await this.wait(1000);
          if (this.session !== current) return 'stopped';
        }
        page.push(line);
      }
      if (page.length) await flush();
      if (this.session !== current) return 'stopped';
      if (!current.listIds.length) throw new Error('Missing reply identifiers');
      current.phase = 'selecting'; current.expiresAt = this.now() + STEP_MS;
      this.store.state.groups = current.groups; this.store.save();
      return 'selecting';
    } catch {
      if (this.session === current) {
        this.session = null; this.store.state.status = 'interrupted'; this.store.save();
        await this.notify(chat, 'Không lấy/gửi được danh sách nhóm cho QC. Kiểm tra đăng nhập rồi gọi lại.');
      }
      return 'error';
    }
  }

  async input(context) {
    const s = this.session, m = context.message;
    if (!s || !qcIsHigh(context) || !this.owns(context) || m.isSelf || String(m.data.uidFrom) === String(this.api.getOwnId())) return false;
    const text = typeof m.data.content === 'string' ? m.data.content : '';
    const parsed = parseCommandContent(text, context.prefix || '!');
    if (await this.expire()) return !parsed;
    const quoted = quotedIds(m);
    const replyToPrompt = quoted.some((id) => s.promptIds.includes(id));
    // QC controls always remain commands, including when quoted.
    if (parsed && (!replyToPrompt || (parsed.command === 'qc' && ['status', 'stop'].includes(parsed.commandParts[1]?.toLowerCase())))) return false;
    const usableId = (value) => value != null && !['', '0', '-1'].includes(String(value).trim());
    const messageId = usableId(m.data.msgId) ? `global:${m.data.msgId}` : usableId(m.data.cliMsgId) ? `client:${m.data.cliMsgId}` : '';
    if (messageId && s.seen.has(messageId)) return true;
    if (s.phase === 'selecting') {
      if (!quoted.some((id) => s.listIds.includes(id))) return false;
      if (messageId) s.seen.add(messageId);
      const tokens = text.trim().split(/\s+/);
      const indices = text.trim().toLowerCase() === 'all' ? s.groups.map((_, i) => i + 1) : tokens.map((token) => /^\d+$/.test(token) ? Number(token) : NaN);
      if (!indices.length || indices.some((n) => !Number.isSafeInteger(n) || n < 1 || n > s.groups.length)) {
        await this.notify(s.chat, 'Số nhóm không hợp lệ. Reply lại danh sách: 1, 1 2 3 hoặc all.'); return true;
      }
      s.phase = 'choosing';
      s.selected = [...new Set(indices)].map((i) => s.groups[i - 1]);
      try {
        const receipts = await this.notify(s.chat, `Đã chọn: ${s.selected.map((g) => g.name).join(', ')}.\nGửi một tin nhắn gốc làm quảng cáo trong 5 phút, không cần reply. Reply lời nhắc này nếu nội dung bắt đầu bằng cú pháp lệnh. Dùng qc stop để hủy.`);
        if (this.session !== s) return true;
        s.promptIds = receipts.flatMap(qcMessageIds); s.phase = 'content'; s.expiresAt = this.now() + STEP_MS;
        this.store.state.status = 'content'; this.store.state.groups = s.selected; this.store.save();
      } catch {
        if (this.session === s) {
          this.session = null; this.store.state.status = 'interrupted'; this.store.save();
        }
      }
      return true;
    }
    if (s.phase !== 'content') return false;
    if (messageId) s.seen.add(messageId);
    s.phase = 'preparing'; // reserve synchronously before any async normalization
    let content;
    try { content = await this.prepare(this.api, m); }
    catch (error) {
      if (this.session === s) {
        if (this.store.state.stopRequested) {
          this.session = null; this.store.state.status = 'stopped'; this.store.state.endedAt = this.now(); this.store.save();
          return true;
        }
        s.phase = 'content'; // retain original deadline, never extend it on unsupported input
        await this.notify(s.chat, `Nội dung chưa thể gửi nguyên dạng: ${error.message}\nVui lòng gửi một tin nhắn khác.`);
      }
      return true;
    }
    if (this.session !== s) { await content.cleanup(); return true; }
    if (this.store.state.stopRequested) {
      this.session = null;
      try { this.store.state.status = 'stopped'; this.store.state.endedAt = this.now(); this.store.save(); }
      finally { await content.cleanup(); }
      return true;
    }
    const task = async () => {
      try { return await runQcCampaign({ api: this.api, store: this.store, groups: s.selected, actor: s.actor, chat: s.chat, content, notify: (msg) => this.notify(s.chat, msg) }); }
      finally { if (this.session === s) this.session = null; }
    };
    try {
      s.phase = 'queued'; this.store.state.status = 'queued'; this.store.state.startedAt = Date.now(); this.store.save();
      if (!this.broker?.submitBroadcast) throw new Error('Broadcast broker unavailable');
      const job = this.broker.submitBroadcast({ command: 'qc' }, task, { timeoutMs: 0 });
      if (job.rejected) throw new Error('Broadcast queue unavailable');
      job.promise.catch(async () => {
        if (this.session === s) {
          this.session = null; this.store.state.status = 'interrupted'; this.store.save();
          await content.cleanup(); await this.notify(s.chat, qcReport(this.store.state));
        }
      }).catch(() => {});
    } catch {
      this.session = null; this.store.state.status = 'interrupted';
      try { this.store.save(); } catch { /* leave the preceding durable checkpoint for restart recovery */ }
      await content.cleanup();
      await this.notify(s.chat, 'Không thể xếp lượt QC vào hàng đợi gửi nền. Chưa gửi quảng cáo.');
    }
    return true;
  }
}
