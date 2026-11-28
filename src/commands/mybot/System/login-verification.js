import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getProjectRoot } from '../../../utils/env.js';
import { credentialError, normalizeLoginCredential } from './credential-normalizer.js';

export async function verifyLoginCredential(input, { root = getProjectRoot(), timeoutMs = 30_000, signal, runWorker } = {}) {
  const credential = normalizeLoginCredential(input);
  if (signal?.aborted) throw credentialError('LOGIN_CANCELLED', 'Đã hủy xác minh đăng nhập.', 'verify');
  const result = await (runWorker ? runWorker(credential, { root, signal }) : runVerificationWorker(credential, { root, timeoutMs, signal }));
  const uid = String(result?.uid || '').trim();
  if (!uid || uid === 'admin') throw credentialError('ACCOUNT_IDENTITY_MISSING', 'Không xác minh được UID tài khoản đăng nhập.', 'verify');
  if (signal?.aborted) throw credentialError('LOGIN_CANCELLED', 'Đã hủy xác minh đăng nhập.', 'verify');
  return { uid, displayName: String(result.displayName || ''), avatar: String(result.avatar || ''), canonicalUsername: String(result.canonicalUsername || '') };
}

function runVerificationWorker(credential, { root, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./login-verification-worker.js', import.meta.url)), [], {
      cwd: root, env: { ...process.env, PROJECT_ROOT: root, ProjectRoot: root, SKIP_ENV_VALIDATION: '1', BOT_ID: 'credential-verifier' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.removeAllListeners();
      const complete = () => error ? reject(error) : resolve(result);
      child.on('error', () => {});
      const exited = !child.pid || child.exitCode !== null || child.signalCode !== null;
      if (!exited) child.once('exit', complete);
      if (child.connected) child.disconnect();
      child.kill();
      if (exited) complete();
    };
    const abort = () => finish(credentialError('LOGIN_CANCELLED', 'Đã hủy xác minh đăng nhập.', 'verify'));
    const timer = setTimeout(() => finish(credentialError('LOGIN_VERIFY_TIMEOUT', 'Xác minh tài khoản quá 30 giây.', 'verify')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(credentialError('LOGIN_WORKER_ERROR', 'Không khởi tạo được tiến trình xác minh.', 'verify')));
    child.once('exit', () => finish(credentialError('LOGIN_WORKER_EXIT', 'Tiến trình xác minh đã dừng trước khi trả kết quả.', 'verify')));
    child.on('message', message => {
      if (message?.type === 'verified') finish(null, message.identity);
      else if (message?.type === 'failed') finish(credentialError('LOGIN_VERIFY_FAILED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.', 'verify'));
    });
    child.send({ credential }, error => { if (error) finish(credentialError('LOGIN_WORKER_ERROR', 'Không gửi được yêu cầu xác minh.', 'verify')); });
  });
}
