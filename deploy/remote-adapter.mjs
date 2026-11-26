const launcher = 'p=/opt/mybot/current/deploy/ubuntu/locked-runner.sh; if [ ! -f "$p" ]; then p=/opt/mybot/deploy-control/bootstrap/ubuntu/locked-runner.sh; fi;';
const uploadPath = /^\/opt\/mybot\/\.runtime\/deploy-upload\.[A-Za-z0-9]+$/;
export function createRemoteAdapter({ run, archive, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 7200 }) {
  if (typeof run !== 'function' || typeof archive !== 'function') throw new Error('Invalid remote transport');
  let activeLauncher = launcher;
  const adapter = {
    setControlRunner(runner) {
      if (!/^\/opt\/mybot\/deploy-control\/releases\/[a-f0-9]{40}(?:[a-f0-9]{24})?\/deploy\/ubuntu\/locked-runner\.sh$/.test(runner)) throw new Error('Invalid deployment control runner');
      activeLauncher = `p='${runner}';`;
    },
    async status() { return JSON.parse(await run(`${launcher} exec bash "$p" /opt/mybot status`)); },
    async upload(dir) {
      const payload = await archive(dir);
      const command = 'set -eu; umask 077; mkdir -p /opt/mybot/.runtime; d=$(mktemp -d /opt/mybot/.runtime/deploy-upload.XXXXXXXX); if tar -xz --no-same-owner -C "$d"; then printf "%s\\n" "$d"; else rm -rf -- "$d"; exit 1; fi';
      const uploaded = (await run(command, payload)).trim();
      if (!uploadPath.test(uploaded)) throw new Error('Invalid upload path returned by VPS');
      return uploaded;
    },
    async launch(operation, arg, id) {
      if (!['apply', 'bootstrap', 'rollback', 'recover'].includes(operation) || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid remote operation');
      if (operation === 'apply' && !uploadPath.test(arg || '')) throw new Error('Invalid upload path');
      if (operation === 'bootstrap' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(arg || '')) throw new Error('Invalid bootstrap commit');
      if (!['apply', 'bootstrap'].includes(operation) && arg !== null) throw new Error('Unexpected operation argument');
      const extra = arg === null ? '' : ` '${arg}'`;
      await run(`${activeLauncher} exec systemd-run --unit=mybot-update-${id} --property=Type=exec -- /bin/bash "$p" /opt/mybot ${operation}${extra} '${id}'`);
    },
    async wait(id) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid request ID');
      let lastLogLine = '';
      for (let i = 0; i < maxPolls; i++) {
        const status = await adapter.status();
        if (status.state?.requestId === id) {
          if (['confirmed', 'already_applied', 'no_changes', 'recovered'].includes(status.state.status)) return status.state;
          if (status.state.status === 'failed') throw new Error(`Deployment failed: ${status.state.error || 'unknown error'}`);
          if (i >= 4 && i % 5 === 4) {
            const unit = (await run(`systemctl show mybot-update-${id}.service -p ActiveState --value`)).trim();
            if (['inactive', 'failed'].includes(unit)) {
              const recheck = await adapter.status();
              if (recheck.state?.requestId === id && ['confirmed', 'already_applied', 'no_changes', 'recovered'].includes(recheck.state.status)) {
                return recheck.state;
              }
              if (recheck.state?.requestId === id && recheck.state.status === 'failed') {
                throw new Error(`Deployment failed: ${recheck.state.error || 'unknown error'}`);
              }
              let detail = unit;
              try {
                const resStr = (await run(`systemctl show mybot-update-${id}.service -p Result --value`)).trim();
                if (resStr) detail = `${unit}/${resStr}`;
              } catch {}
              throw new Error(`Deployment worker terminated unexpectedly (${detail})`);
            }
            if (maxPolls >= 100) {
              try {
                const line = (await run(`journalctl -u mybot-update-${id}.service -n 1 -o cat --no-pager 2>/dev/null || true`)).trim();
                if (line && line !== lastLogLine) {
                  lastLogLine = line;
                  console.log(`[VPS Build] ${line}`);
                }
              } catch {}
            }
          }
        } else if (i >= 3) {
          const unit = (await run(`systemctl show mybot-update-${id}.service -p ActiveState --value`)).trim();
          if (['inactive', 'failed'].includes(unit)) throw new Error('Deployment worker stopped before recording status');
        }
        await delay(1000);
      }
      throw new Error('Deployment is still running; check --status');
    },
  };
  return adapter;
}
