import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import readline from 'node:readline/promises';
import {validateVpsConfig,setupAskpass,buildSshAuthArgs} from './vps-deploy-config.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
let helper;
try {
  const cfg=validateVpsConfig(JSON.parse(fs.readFileSync(path.join(repo,'deploy/vps-deploy.local.json'),'utf8')));
  helper=setupAskpass(cfg.password);
  const run=(command)=>{
    const result=spawnSync(process.platform==='win32'?'ssh.exe':'ssh',['-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=15',...buildSshAuthArgs(cfg),'-p',String(cfg.port),`${cfg.user}@${cfg.host}`,command],{env:helper?.env??process.env,encoding:'utf8',maxBuffer:4*1024*1024,timeout:600000,windowsHide:true});
    if(result.error||result.status!==0)throw result.error||new Error(result.stderr.trim()||'Portal setup failed');
    return result.stdout;
  };
  console.log('Chạy DAY_LEN_VPS.bat trước để cài bản portal đã commit.');
  const username=(await prompt.question('Tên tài khoản vận hành (Enter: operator): ')).trim()||'operator';
  if(!/^[A-Za-z0-9_.-]{3,64}$/.test(username))throw new Error('Tên tài khoản phải gồm 3–64 ký tự chữ, số, _, . hoặc -.');
  console.log(run(`set -eu; set -a; . /etc/mybot/portal.env; set +a; /opt/mybot/current/bin/mybot-portal bootstrap-operator '${username}'`));
  console.log('Lưu token kích hoạt và mã TOTP ở nơi riêng. Mở /activate?token=TOKEN trên portal để đặt mật khẩu.');
  const domain=(await prompt.question('Domain đã trỏ DNS về VPS (Enter để cấu hình HTTPS sau): ')).trim();
  if(domain){
    if(!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(domain))throw new Error('Domain không hợp lệ');
    console.log(run(`bash /opt/mybot/current/deploy/ubuntu/publish-portal.sh '${domain}'`));
  }
} catch(error){console.error(error.message);process.exitCode=1;}
finally{helper?.cleanup();prompt.close();}
