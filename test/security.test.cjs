const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const root = path.resolve(__dirname, '..');
const origin = 'https://xyy1314qwq.github.io';
const input = {text:'This is a harmless classroom test.',context:[],glossary:'',courseHint:'',mode:'lecture'};

async function runtime(t, extra = {}, persistPath) {
  const options = convertV4MiniflareOptions({
    ...(persistPath ? {resourcePersistencePath:persistPath} : {}),
    workers: [
      { name:'app', modules:[
          {type:'ESModule',path:path.join(root,'cloudflare-worker-deepseek.js')},
          {type:'ESModule',path:path.join(root,'usage-budget.js')},
        ],
        modulesRoot:root, compatibilityDate:'2026-08-12',
        bindings:{TRANSLATION_TOKEN_SECRET:'offline-signing-placeholder',DEEPGRAM_API_KEY:'offline-provider-placeholder',DEEPSEEK_API_KEY:'offline-provider-placeholder',...extra},
        durableObjects:{USAGE_GUARD:{className:'UsageGuard',useSQLite:true}}, outboundService:'provider' },
      { name:'provider', modules:true, scriptPath:path.join(__dirname,'mock-provider.mjs'),compatibilityDate:'2026-08-12' },
    ],
  });
  const mf = new Miniflare(options);
  t.after(()=>mf.dispose());
  const provider = await mf.getWorker('provider');
  function request(route,{ip='192.0.2.10',token,body={},headers={}}={}) {
    return mf.dispatchFetch('https://translator.test'+route,{
      method:route.startsWith('/listen')?'GET':'POST',
      headers:{Origin:origin,'CF-Connecting-IP':ip,'Content-Type':'application/json',...(token?{'X-Translation-Token':token}:{}),...headers},
      ...(route.startsWith('/listen')?{}:{body:JSON.stringify(body)}),
    });
  }
  async function issue(ip) {
    const r=await request('/token',{ip});assert.equal(r.status,200,await r.clone().text());
    const result=await r.json();assert.equal(result.deepgramToken,undefined);assert.equal(result.speechMode,'relay');return result.token;
  }
  async function listen(token,ip,query='') {
    const r=await request('/listen'+query,{ip,headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'translator, '+token}});
    if(r.webSocket)r.webSocket.accept();return r;
  }
  return {mf,request,issue,listen,provider,stats:async()=> (await provider.fetch('https://test.invalid/stats')).json()};
}

function event(socket,name,timeout=5000) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Timed out waiting for '+name)),timeout);
    if(name==='message')socket.addEventListener('close',e=>{clearTimeout(timer);reject(new Error('Closed before message: '+e.code+' '+e.reason))},{once:true});
    socket.addEventListener(name,e=>{clearTimeout(timer);resolve(e)},{once:true});
  });
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,80));

test('new tokens and parallel requests share one stable translation quota',async t=>{
  const app=await runtime(t);
  const a=await app.issue(), b=await app.issue();
  const rs=await Promise.all(Array.from({length:65},(_,i)=>app.request('/translate',{token:i%2?a:b,body:input})));
  assert.equal(rs.filter(r=>r.status===200).length,60);
  assert.equal(rs.filter(r=>r.status===429).length,5);
  const c=await app.issue();
  assert.equal((await app.request('/translate',{token:c,body:input})).status,429);
  const d=await app.issue('192.0.2.11');
  assert.equal((await app.request('/translate',{ip:'192.0.2.11',token:d,body:input})).status,200);
  assert.equal((await app.stats()).translations,61);
  assert.equal((await app.stats()).grants,0);
});

test('token issuance is limited and signature/IP/origin rejection remains intact',async t=>{
  const app=await runtime(t);const token=await app.issue();
  for(let i=1;i<6;i++)await app.issue();
  assert.equal((await app.request('/token')).status,429);
  assert.equal((await app.request('/translate',{token:token+'x',body:input})).status,401);
  assert.equal((await app.request('/translate',{ip:'192.0.2.11',token,body:input})).status,401);
  assert.equal((await app.request('/translate',{token,body:input,headers:{Origin:'https://untrusted.invalid'}})).status,403);
  // The local ingress fills an absent CF-Connecting-IP just as an edge does.
  assert.equal((await app.request('/token',{headers:{'CF-Connecting-IP':'invalid','X-Forwarded-For':'192.0.2.99'}})).status,400);
  assert.equal((await app.stats()).grants,0);assert.equal((await app.stats()).translations,0);
});

test('pending and active speech sessions count together; close frees one slot',async t=>{
  const app=await runtime(t,{MAX_CONCURRENT_PER_IP:'1'});const token=await app.issue();
  await app.provider.fetch('https://test.invalid/delay-next');
  const pending=app.listen(token);await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await app.listen(token)).status,429);
  const first=await pending;assert.equal(first.status,101);
  const nextToken=await app.issue();assert.equal((await app.listen(nextToken)).status,429);
  assert.equal((await app.stats()).connections,1);
  const received=event(first.webSocket,'message');first.webSocket.send(new Uint8Array(8192));
  assert.equal(JSON.parse((await received).data).audioBytes,8192);
  first.webSocket.close(1000);await tick();
  const next=await app.listen(nextToken);assert.equal(next.status,101);next.webSocket.close(1000);
});

test('provider handshake failure releases the pending reservation',async t=>{
  const app=await runtime(t,{MAX_CONCURRENT_PER_IP:'1'});const token=await app.issue();
  await app.provider.fetch('https://test.invalid/fail-next');
  assert.equal((await app.listen(token)).status,502);
  const next=await app.listen(token);assert.equal(next.status,101);next.webSocket.close(1000);
});

test('speech fixes metering format and blocks duplicates and control-message changes',async t=>{
  const app=await runtime(t);const token=await app.issue();
  for(const query of ['?sample_rate=8000','?model=other','?diarize=true&diarize=false','?callback=https://example.com']){
    assert.equal((await app.listen(token,undefined,query)).status,400);
  }
  assert.equal((await app.stats()).connections,0);
  const r=await app.listen(token,undefined,'?diarize=true');assert.equal(r.status,101);
  const url=new URL((await app.stats()).urls[0]);
  assert.equal(url.searchParams.get('sample_rate'),'16000');assert.equal(url.searchParams.get('channels'),'1');assert.equal(url.searchParams.get('diarize'),'true');
  const closed=event(r.webSocket,'close');r.webSocket.send(JSON.stringify({type:'Configure',sample_rate:8000}));
  assert.equal((await closed).code,4008);
});

test('daily audio is debited before forwarding and is not reset by reconnect',async t=>{
  const app=await runtime(t,{DAILY_AUDIO_SECONDS_PER_IP:'1'});const token=await app.issue();
  const r=await app.listen(token);
  const received=event(r.webSocket,'message');r.webSocket.send(new Uint8Array(32000));await received;
  const closed=event(r.webSocket,'close');r.webSocket.send(new Uint8Array(2));assert.equal((await closed).code,4008);
  assert.equal((await app.stats()).audioBytes,32000);
  const next=await app.listen(await app.issue());const again=event(next.webSocket,'close');next.webSocket.send(new Uint8Array(2));await again;
  assert.equal((await app.stats()).audioBytes,32000);
});

test('large and accelerated audio cannot reach the provider unmetered',async t=>{
  const app=await runtime(t);const token=await app.issue();
  const oversized=await app.listen(token);const closeLarge=event(oversized.webSocket,'close');oversized.webSocket.send(new Uint8Array(65538));await closeLarge;
  assert.equal((await app.stats()).audioBytes,0);
  const fast=await app.listen(token);const closeFast=event(fast.webSocket,'close');
  for(let i=0;i<4;i++)fast.webSocket.send(new Uint8Array(64000));
  assert.equal((await closeFast).code,4008);
  assert.ok((await app.stats()).audioBytes<=160000);
});

test('session deadline closes idle sockets and frees capacity',async t=>{
  const app=await runtime(t,{MAX_SESSION_SECONDS:'1',MAX_CONCURRENT_PER_IP:'1'});const token=await app.issue();
  const first=await app.listen(token);assert.equal((await event(first.webSocket,'close')).code,4008);
  const next=await app.listen(token);assert.equal(next.status,101);next.webSocket.close(1000);
});

test('daily global limits cannot be evaded by choosing another IP',async t=>{
  const app=await runtime(t,{DAILY_TRANSLATIONS_GLOBAL:'1',MAX_CONCURRENT_GLOBAL:'1'});
  const one=await app.issue(),two=await app.issue('192.0.2.11');
  assert.equal((await app.request('/translate',{token:one,body:input})).status,200);
  assert.equal((await app.request('/translate',{token:two,ip:'192.0.2.11',body:input})).status,429);
  const first=await app.listen(one);assert.equal((await app.listen(two,'192.0.2.11')).status,429);first.webSocket.close(1000);
});

test('daily usage survives a real Workers runtime restart',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'translator-budget-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const app=await runtime(t,{DAILY_TRANSLATIONS_PER_IP:'1'},folder);const token=await app.issue();
  assert.equal((await app.request('/translate',{token,body:input})).status,200);
  await app.mf.dispose();
  const restarted=await runtime(t,{DAILY_TRANSLATIONS_PER_IP:'1'},folder);const next=await restarted.issue();
  assert.equal((await restarted.request('/translate',{token:next,body:input})).status,429);
  assert.equal((await restarted.stats()).translations,0);
});
