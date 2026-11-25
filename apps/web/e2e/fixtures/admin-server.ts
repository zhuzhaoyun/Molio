import { test as base, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { randomBytes, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(join(root, 'apps/daemon/package.json'));
const Database = require('better-sqlite3');
export interface AdminServer {
  origin: string; dataDir: string; vaultDir: string; username: string; password: string;
  stop(): Promise<void>; restart(): Promise<void>; pause(): Promise<void>; expireSession(digest: string): Promise<void>;
}
async function kill(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); await new Promise<void>(r => { const t=setTimeout(()=>{child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(t);r();}); });
}
export async function startAdminServer(options: { webDir: string; username: string; password: string; mode?: 'server' | 'local' }): Promise<AdminServer> {
  const dir=mkdtempSync(join(tmpdir(),'molio-admin-ui-'));const dataDir=join(dir,'data');const vaultDir=join(dir,'vault');mkdirSync(vaultDir);
  writeFileSync(join(vaultDir,'acceptance.md'),'# Private acceptance marker\n\nOriginal saved text.\n');
  writeFileSync(join(vaultDir,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64'));
  copyFileSync(join(root,'apps/web/e2e/fixtures/sample.pdf'),join(vaultDir,'sample.pdf'));
  writeFileSync(join(vaultDir,'images.md'),'# Private image\n\n![private](pixel.png)');
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const socket=createSocket();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const daemonPort=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
  const proxy=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
    const upstream=httpRequest({hostname:'127.0.0.1',port:daemonPort,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());
  });
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const origin=`https://localhost:${(proxy.address() as {port:number}).port}`;
  const salt=randomBytes(16);const hash=scryptSync(options.password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const encoded=`scrypt$32768$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
  let child:ChildProcess|undefined;let diagnostics='';let stopped=false;
  async function start() {
    diagnostics='';child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:join(root,'apps/daemon'),stdio:['ignore','pipe','pipe'],env:{...process.env,MOLIO_ACCESS_MODE:options.mode??'server',MOLIO_HOST:'127.0.0.1',MOLIO_PORT:String(daemonPort),MOLIO_PUBLIC_URL:origin,MOLIO_ADMIN_USERNAME:options.username,MOLIO_ADMIN_PASSWORD_HASH:encoded,MOLIO_DATA_DIR:dataDir,MOLIO_STATIC_DIR:options.webDir,MOLIO_DEFAULT_VAULT_PATH:vaultDir,MOLIO_SAMPLE_VAULT_PATH:join(dir,'sample'),MOLIO_CLAUDE_HOME:join(dir,'claude'),MOLIO_CODEX_HOME:join(dir,'codex'),MOLIO_AUTH_URL:' ',MOLIO_CHORES_DELAY_MS:'300000'}});
    const collect=(data:Buffer)=>{diagnostics=(diagnostics+data.toString()).slice(-6000);};child.stdout?.on('data',collect);child.stderr?.on('data',collect);
    for(let i=0;i<200;i++) {try{if((await fetch(`http://127.0.0.1:${daemonPort}/api/health`)).ok)return;}catch{} if(child.exitCode!==null)break;await delay(100);}
    throw new Error(`isolated daemon did not start: ${diagnostics.replaceAll(encoded,'[redacted]')}`);
  }
  const stop=async()=>{if(stopped)return;stopped=true;await kill(child);proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));rmSync(dir,{recursive:true,force:true});};
  try{await start();}catch(err){await stop();throw err;}
  return {origin,dataDir,vaultDir,...options,stop,pause:()=>kill(child),restart:async()=>{await kill(child);await start();},expireSession:async digest=>{const db=new Database(join(dataDir,'app.sqlite'));try{db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_digest = ?').run(Date.now()-1,digest);}finally{db.close();}}};
}
export const test=base.extend<{admin:AdminServer},{adminWebDir:string}>({
  adminWebDir:[async({},use)=>{
    const output = process.env.MOLIO_ADMIN_WEB_BUILD;
    if (!output) throw new Error('Administrator assets must be freshly built by globalSetup');
    await use(output);
  },{scope:'worker',timeout:180000,auto:true}],
  admin:async({adminWebDir},use)=>{const server=await startAdminServer({webDir:adminWebDir,username:'acceptance-admin',password:randomBytes(24).toString('hex')});try{await use(server);}finally{await server.stop();}},
});
test.use({ignoreHTTPSErrors:true});
export { expect };
