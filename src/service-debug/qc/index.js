import path from 'node:path';
import { getRuntimeContext } from '../../utils/bot-runtime-context.js';
import { getActiveRuntimeLifecycle } from '../../core/runtime-lifecycle.js';
import { prepareQcContent } from './content.js';
import { QcSession, qcIsHigh } from './session.js';

const managers = new Map();
const liveManagers = new Map();

function managerFor(context) {
  const ownUid = String(context.api.getOwnId?.() || '');
  if (!/^[1-9]\d*$/.test(ownUid)) throw new Error('QC cần UID bot đã đăng nhập.');
  const runtime = context.runtimeContext || getRuntimeContext();
  const checkpointFile = path.join(runtime.dataDir, 'qc', `${ownUid}.json`);
  let manager = managers.get(checkpointFile);
  if (!manager) {
    manager = new QcSession({ api: context.api, checkpointFile, prepare: prepareQcContent });
    managers.set(checkpointFile, manager);
    liveManagers.set(ownUid, manager);
  }
  manager.api = context.api;
  manager.broker = context.workloadBroker || getActiveRuntimeLifecycle()?.workloadBroker;
  return manager;
}

export async function qcCommand(context) {
  if (!qcIsHigh(context)) return 'denied';
  try {
    const manager = managerFor(context);
    if (!context.args?.length) {
      // Group enumeration and paged responses can exceed the control deadline.
      // The command returns immediately, while status/stop keep their own lane.
      manager.command(context).catch(() => context.api.sendMessage({msg:'Không mở được QC. Cần kiểm tra checkpoint và đăng nhập.',strict:true,linkOn:false},context.message.threadId,context.message.type).catch(()=>{}));
      return 'opening';
    }
    return await manager.command(context);
  } catch {
    await context.api.sendMessage({msg:'Không mở được QC. Cần kiểm tra checkpoint và đăng nhập.',strict:true,linkOn:false},context.message.threadId,context.message.type);
    return 'unavailable';
  }
}

export async function handleQcInput(context) {
  if (!qcIsHigh(context)) return false;
  const manager = liveManagers.get(String(context.api.getOwnId?.() || ''));
  if (!manager?.session) return false;
  manager.api = context.api;
  try {
    const handled = await manager.input(context);
    if (handled) context.message.qcHandled = true;
    return handled;
  } catch (error) {
    context.message.qcHandled = true;
    // Never let persistence failure route campaign input into chatbot/downloads.
    console.error('[qc] input unavailable:', error?.code || error?.name || 'Error');
    await context.api.sendMessage({msg:'QC không thể đọc/ghi checkpoint. Đã dừng xử lý nội dung; cần kiểm tra trạng thái QC.',strict:true,linkOn:false},context.message.threadId,context.message.type).catch(()=>{});
    return true;
  }
}
