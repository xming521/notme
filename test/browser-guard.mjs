import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, access, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Network from '../lib/network.js';

const temporary = await mkdtemp(join(tmpdir(), 'notme-browser-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=notme-test',
  '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem')], { stdio: 'ignore' });
const traffic = [];
const policies = new Map();
const results = [];
const font = await readFile(execFileSync('fc-match', ['-f', '%{file}', 'DejaVu Sans'], { encoding: 'utf8' }));
const server = createServer({ key: await readFile(join(temporary, 'key.pem')), cert: await readFile(join(temporary, 'cert.pem')) }, (request, response) => {
  const host = request.headers.host;
  const url = new URL(request.url, `https://${host}`);
  traffic.push({ host, path: url.pathname, cookie: request.headers.cookie || '', language: request.headers['accept-language'] || '', ua: request.headers['user-agent'] || '' });
  response.setHeader('Cache-Control', url.pathname === '/cached' ? 'public, max-age=3600' : 'no-store');
  const policy = policies.get(host) || {};
  if (host === 'outside.test' && url.pathname === '/oauth-redirect') {
    response.writeHead(302,{Location:'https://claude.ai/oauth/redirected?code=synthetic%26code&state=synthetic%3Dstate&extra=1'});response.end();
  } else if (url.pathname === '/cdn-cgi/trace') {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/plain');
    response.setHeader('Alt-Svc','h3=":443"; ma=3600');
    const body = policy.invalid ? 'challenge' : `h=${host.replace(/\.$/, '')}\nip=${policy.ip || '203.0.113.42'}\nloc=${policy.country || 'US'}\ncolo=LAX\nhttp=${policy.protocol || 'http/2'}\n`;
    if (policy.delayMs) setTimeout(() => response.end(body), policy.delayMs); else response.end(body);
  } else if (['ipwho.is', 'ipapi.co', 'ipinfo.io'].includes(host)) {
    const requested = Network.normalizeIP(decodeURIComponent(url.pathname.split('/')[1])) || '203.0.113.42';
    const geoPolicy = policies.get(`${host}/${requested}`) || policy;
    const ip = geoPolicy.ip || requested;
    const jp = ip === '203.0.113.43';
    response.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify(geoPolicy.invalid ? {success:false} : { ip, success: true, country_code: geoPolicy.country || (jp ? 'JP' : 'US'),
      country: geoPolicy.country || (jp ? 'JP' : 'US'),
      latitude: jp ? 35.68 : 34.05, longitude: jp ? 139.69 : -118.24, city: 'Test City',
      timezone: geoPolicy.missingTimezone ? undefined : host === 'ipwho.is' ? { id: jp ? 'Asia/Tokyo' : 'America/Los_Angeles' }
        : jp ? 'Asia/Tokyo' : 'America/Los_Angeles' });
    if (geoPolicy.delayMs) setTimeout(()=>response.end(body),geoPolicy.delayMs); else response.end(body);
  } else if (host === 'reallyfreegeoip.org') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ip: policy.ip || '203.0.113.42', country_code: policy.country || 'US', country_name: 'Test country', latitude: 34.05, longitude: -118.24 }));
  } else if (/overpass|maps.mail/.test(host)) {
    response.setHeader('Content-Type', 'application/json'); response.end('{"elements":[]}');
  } else if (host === 'api.bigdatacloud.net') {
    response.setHeader('Content-Type', 'application/json'); response.end('{"city":"Test City","countryName":"Test country"}');
  } else if (url.pathname === '/asset.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end('window.assetLoaded=true;');
  } else if (url.pathname === '/fixture.ttf') {
    response.setHeader('Content-Type', 'font/ttf'); response.setHeader('Access-Control-Allow-Origin', '*'); response.end(font);
  } else if (url.pathname === '/worker.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end('self.postMessage({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language});');
  } else if (url.pathname === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(`self.addEventListener('install',e=>e.waitUntil((async()=>{
      const cache=await caches.open('offline-test');await cache.put('/offline',new Response('<h1 id="offline">SW CACHE CONTENT</h1>',{headers:{'Content-Type':'text/html'}}));await self.skipWaiting();
      })()));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.match('/offline'));});`);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><link rel="icon" href="data:,"><script>
      window.first={language:navigator.language,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,ua:navigator.userAgent,hash:location.hash};
      window.addEventListener('pageshow',e=>document.documentElement.dataset.persisted=e.persisted);
      </script><script src="https://${Network.protectedHost(`https://${host}/`) ? 'assets.claude.ai' : 'assets.outside.test'}/asset.js"></script></head><body><h1 id="formal">FORMAL CONTENT</h1></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const proxy = createProxy();
proxy.on('connect', (request, socket, head) => {
  const upstream = connect(server.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
let udpIP = '203.0.113.42';
let udpRespond = true;
let udpRequests = 0;
const stun = createSocket('udp4');
stun.on('message', (request, remote) => {
  udpRequests++;
  if (!udpRespond || request.length < 20 || request.readUInt16BE(0) !== 1) return;
  const response=Buffer.alloc(32);response.writeUInt16BE(0x0101,0);response.writeUInt16BE(12,2);request.copy(response,4,4,20);
  response.writeUInt16BE(0x0020,20);response.writeUInt16BE(8,22);response[25]=1;response.writeUInt16BE(remote.port ^ 0x2112,26);
  const mask=[0x21,0x12,0xa4,0x42];udpIP.split('.').forEach((part,index)=>response[28+index]=Number(part)^mask[index]);
  stun.send(response,remote.port,remote.address);
});
await new Promise(resolve => stun.bind(0,'127.0.0.1',resolve));

async function executable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { const expected = chromium.executablePath(); await access(expected); return expected; } catch {}
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const names = (await readdir(cache)).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of names) {
    const path = join(cache, name, 'chrome-linux64', 'chrome');
    try { await access(path); return path; } catch {}
  }
  throw new Error('Set CHROMIUM_PATH to an installed Chromium browser');
}
let context;
let control;
let page;
async function redirectStun(context) {
  await context.addInitScript(({port}) => {
    const Native=window.RTCPeerConnection;
    if (Native) window.RTCPeerConnection=new Proxy(Native,{construct(target,args){
      const config={...args[0]};
      if(config.iceServers?.some(server=>String(server.urls).includes('stun.cloudflare.com'))) config.iceServers=[{urls:`stun:127.0.0.1:${port}`}];
      return Reflect.construct(target,[config]);
    }});
  }, {port:stun.address().port});
}
try {
  const options = {
    executablePath: await executable(), headless: true, viewport: { width: 1100, height: 1050 },
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', geolocation: { latitude: 31.23, longitude: 121.47 },
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: ['--no-sandbox', '--ignore-certificate-errors', `--proxy-server=http://127.0.0.1:${proxy.address().port}`],
  };
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), options);
  const seed = await context.newPage(); await seed.goto('https://cached.claude.ai/seed');
  await seed.evaluate(async () => { localStorage.setItem('keep','synthetic');await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready; });
  await seed.reload(); await seed.locator('#offline').waitFor();
  await context.addCookies([{name:'seedLogin',value:'synthetic',domain:'cached.claude.ai',path:'/',secure:true,expires:Date.now()/1000+86400}]);
  await seed.goto('https://outside.test/seed');
  await seed.evaluate(async () => {const cache=await caches.open('unrelated');await cache.put('/keep',new Response('synthetic'));});
  const baselineWorker=await seed.evaluate(()=>new Promise((resolve,reject)=>{
    const worker=new Worker('/worker.js');worker.onmessage=event=>{resolve(event.data);worker.terminate();};worker.onerror=reject;
  }));
  await context.close();
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...options,args:[...options.args,`--disable-extensions-except=${resolve('.')}`,`--load-extension=${resolve('.')}`],
  });
  await redirectStun(context);
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension:'))
    || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith('chrome-extension:') });
  const id = new URL(worker.url()).hostname;
  assert.equal(id, 'jnppijkakhomofmffakonooanpggmoff', '发布的固定 ID 不应变化');
  control = await context.newPage(); await control.goto(`chrome-extension://${id}/gate.html?settings`);
  await context.grantPermissions(['geolocation']);
  const original = await control.evaluate(() => ({ language: navigator.language, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, ua: navigator.userAgent }));
  const send = (message) => control.evaluate(message => chrome.runtime.sendMessage(message), message);
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Browser condition timed out');
  };
  const openGate = async (page, url) => {
    if (Network.protectedHost(page.url())) await page.goto('https://outside.test/new-visit');
    await page.goto(url).catch(error => { if (!/ERR_ABORTED|ERR_FAILED/.test(error.message)) throw error; });
    await wait(async () => page.url().startsWith(`chrome-extension://${id}/gate.html`));
    await page.getByRole('button', { name: '确认并访问', exact: true }).waitFor();
    await wait(async () => await page.locator('#retry').isEnabled());
  };
  const ageCheck = async (page, age = 16000) => {
    const id = await page.evaluate(async()=> (await chrome.tabs.getCurrent()).id);
    await worker.evaluate(async({id,age})=>{
      const view=await NotmeGuard.message({type:'NOTME_GUARD_STATE',tabId:id},{id:chrome.runtime.id,url:chrome.runtime.getURL('gate.html')});
      view.report.checkedAt=Date.now()-age;
    },{id,age});
  };
  const confirm = async (page) => {
    await page.getByRole('button', { name: '确认并访问', exact: true }).click();
    await page.locator('#formal').waitFor();
  };
  const select = async (page, label, mode) => {
    await page.getByRole('radio', { name: `${label}：${mode}`, exact: true }).check();
    await wait(async () => await page.locator('#retry').isEnabled());
  };
  const preset = async (page, name) => {
    await page.getByRole('button', { name, exact: true }).click();
    await wait(async () => await page.locator('#retry').isEnabled());
  };
  const location = page => page.evaluate(() => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(p => resolve({ lat:p.coords.latitude, lon:p.coords.longitude }), reject)));
  const deniedLocation = page => page.evaluate(async () => {
    const get = await new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('leaked'), error => resolve(error.code)));
    const watch = await new Promise(resolve => { let id; id = navigator.geolocation.watchPosition(() => { navigator.geolocation.clearWatch(id); resolve('leaked'); }, error => { navigator.geolocation.clearWatch(id); resolve(error.code); }); });
    return { get, watch, permission: (await navigator.permissions.query({name:'geolocation'})).state };
  });
  const workerProfile = page => page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js'); worker.onmessage = event => { resolve(event.data); worker.terminate(); }; worker.onerror = reject;
  }));
  const fontWidths = page => page.evaluate(async () => {
    const face = await new FontFace('Microsoft YaHei', 'url('+location.origin+'/fixture.ttf)').load(); document.fonts.add(face);
    const context = document.createElement('canvas').getContext('2d');
    context.font = '30px "Microsoft YaHei", monospace'; const custom = context.measureText('Wiiii').width;
    context.font = '30px monospace'; return { custom, generic: context.measureText('Wiiii').width };
  });
  const pass = name => { results.push(name); console.log('PASS ' + name); };
  const formalRequests = () => traffic.filter(item => Network.protectedHost(`https://${item.host}/`) && item.path !== '/cdn-cgi/trace');
  const rtc = page => page.evaluate(() => {
    try { const peer=new RTCPeerConnection({iceServers:[]});peer.createDataChannel('test');peer.close();return 'allowed'; }
    catch(error) { return error.name; }
  });
  const verifyOrdinary = async (page,url) => {
    await page.goto(url);await page.locator('#formal').waitFor();
    await wait(async()=>await page.evaluate(()=>window.assetLoaded===true));
    assert.deepEqual(await page.evaluate(()=>({language:navigator.language,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,ua:navigator.userAgent})),original);
    assert.deepEqual(await page.evaluate(()=>({language:window.first.language,zone:window.first.zone,ua:window.first.ua})),original);
    const target=new URL(url);const header=traffic.findLast(item=>item.host===target.hostname&&item.path===target.pathname);
    assert.ok(header.language.startsWith(original.language));assert.equal(header.ua,original.ua);
    assert.deepEqual(await location(page),{lat:31.23,lon:121.47});
    assert.deepEqual(await workerProfile(page),baselineWorker);
    const widths=await fontWidths(page);assert.notEqual(widths.custom,widths.generic);
    assert.equal(await rtc(page),'allowed');
    assert.equal(await page.evaluate(()=>('GeoMirrorTZ' in window)||('NotmeIdentity' in window)),false);
  };
  const checkDetails = async page => {
    if (!await page.locator('#diagnostics').evaluate(node => node.open)) await page.locator('#diagnostics > summary').click();
    return page.locator('#checks').innerText();
  };

  await wait(async () => await control.locator('#retry').isEnabled());
  assert.equal(await control.locator('#heading').innerText(), '设置默认环境。');
  assert.match(await control.locator('#environment-info').textContent(),/第三方查 IP 服务.*不代表 Anthropic/);
  assert.equal(await control.locator('#confirm').isVisible(), false);
  assert.equal(await control.locator('#advanced').evaluate(node => node.open), false);
  assert.equal(await control.locator('#choices input:checked').count(), 7);
  assert.equal(await worker.evaluate(() => chrome.action.onClicked.hasListener(openEnvironmentPage)), true);
  await worker.evaluate(() => openEnvironmentPage({url:'https://outside.test/'}));
  assert.equal((await context.pages().filter(page => page.url().endsWith('gate.html?settings'))).length, 1);
  pass('工具栏入口与默认设置使用合并页面，七项选择完整，高级设置默认收起，重复点击复用标签页');

  const offline = await context.newPage();
  await openGate(offline, 'https://cached.claude.ai/reopen');
  await preset(offline, '全部使用系统默认'); await confirm(offline);
  assert.deepEqual(await offline.evaluate(async () => ({ registrations:(await navigator.serviceWorker.getRegistrations()).length,
    caches:await caches.keys(),keep:localStorage.getItem('keep') })), { registrations:0,caches:[],keep:'synthetic' });
  assert.ok((await context.cookies('https://cached.claude.ai')).some(cookie => cookie.name === 'seedLogin' && cookie.value === 'synthetic'));
  await offline.goto('https://outside.test/seed');
  assert.ok((await offline.evaluate(() => caches.keys())).includes('unrelated'));
  await offline.close();
  pass('已有 Service Worker 离线页面回到检查页，清除目标离线缓存并保留 Cookie、本地数据和其他站点缓存');

  page = await context.newPage();
  await context.addCookies([{ name: 'testSession', value: 'synthetic', domain: '.claude.ai', path: '/', secure: true }]);
  traffic.length = 0;
  await openGate(page, 'https://claude.ai/page?test=1#original');
  assert.equal(formalRequests().length, 0);
  assert.equal(await page.locator('#confirm').isEnabled(), true);
  assert.ok(traffic.filter(item => item.path === '/cdn-cgi/trace').every(item => !item.cookie));
  await page.waitForTimeout(200);
  assert.equal(formalRequests().length, 0);
  pass('检查通过后仍等待明确确认，正式 HTML / 脚本 / 资源请求数为零');
  assert.equal(await page.locator('#check-progress').getAttribute('data-running'),'false');
  assert.match(await page.locator('#progress-label').textContent(),/检查完成/);
  const pendingTabId=await page.evaluate(async()=> (await chrome.tabs.getCurrent()).id);
  await worker.evaluate(async tabId=>{
    const view=await NotmeGuard.message({type:'NOTME_GUARD_STATE',tabId},{id:chrome.runtime.id,url:chrome.runtime.getURL('gate.html')});
    const entries=Object.entries(view.selection).reverse();
    for(const key of Object.keys(view.selection)) delete view.selection[key];
    Object.assign(view.selection,Object.fromEntries(entries));
  },pendingTabId);
  traffic.length=0;const udpBeforeQuickConfirm=udpRequests;
  await confirm(page);
  assert.equal(traffic.some(item=>item.path==='/cdn-cgi/trace'),false);
  assert.equal(udpRequests,udpBeforeQuickConfirm);
  pass('检查完成 15 秒内确认直接进入，不重复 HTTPS 或 UDP 探测，后台恢复后属性顺序变化不会误报环境变化');
  const first = await page.evaluate(() => window.first);
  assert.equal(first.language, 'en-US'); assert.equal(first.zone, 'America/Los_Angeles'); assert.equal(first.hash, '#original');
  assert.ok(!first.ua.includes('HeadlessChrome'));
  assert.equal(formalRequests().find(item => item.path === '/page').language, 'en-US,en;q=0.9');
  assert.ok(await page.evaluate(() => window.assetLoaded));
  assert.equal(await rtc(page),'NotAllowedError');
  assert.equal(await page.evaluate(()=>{try{new RTCPeerConnection.prototype.constructor({iceServers:[]});return 'allowed';}catch(error){return error.name;}}),'NotAllowedError');
  assert.notEqual((await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.get({}))).levelOfControl,'controlled_by_this_extension');
  pass('点击确认后才加载网站；第一个内联脚本已获得正确时区、语言与标识，HTTP 头同步');
  assert.deepEqual(await deniedLocation(page),{get:1,watch:1,permission:'denied'});
  assert.equal(traffic.some(item=>/overpass|maps\.mail|api\.bigdatacloud/.test(item.host)),false);
  const blank=await page.evaluateHandle(()=>{const frame=document.createElement('iframe');document.body.append(frame);return frame.contentWindow;});
  assert.equal(await blank.evaluate(win=>new Promise(resolve=>win.navigator.geolocation.getCurrentPosition(()=>resolve('leaked'),error=>resolve(error.code)))),1);
  pass('默认拒绝定位，getCurrentPosition、watchPosition 和继承框架都不返回坐标，且不查询住宅街道或地址');

  const parallelConfirm=await context.newPage();await openGate(parallelConfirm,'https://claude.ai/parallel-confirm');
  await ageCheck(parallelConfirm,61000);
  await parallelConfirm.evaluate(()=>{
    const original=NotmeUDP.probe;
    NotmeUDP.probe=async options=>{await new Promise(resolve=>window.releaseUDP=resolve);return original(options);};
  });
  traffic.length=0;
  await parallelConfirm.locator('#confirm').click();
  await wait(async()=>traffic.some(item=>item.host==='claude.ai'&&item.path==='/cdn-cgi/trace'));
  assert.equal(formalRequests().length,0);
  assert.equal(await parallelConfirm.locator('#confirm').textContent(),'正在复查…');
  assert.equal(await parallelConfirm.locator('#check-progress').getAttribute('data-running'),'true');
  assert.equal(await parallelConfirm.locator('#progress-track').getAttribute('aria-valuenow'),null);
  await wait(async()=>await parallelConfirm.evaluate(()=>typeof window.releaseUDP==='function'));
  await parallelConfirm.evaluate(()=>window.releaseUDP());
  await parallelConfirm.locator('#formal').waitFor();await parallelConfirm.close();
  pass('确认时 HTTPS 复查与 UDP 并行；UDP 尚未完成前不放行正式请求');

  const outside=await context.newPage();
  for(const host of ['outside.test','claude.ai.evil.test','fakeanthropic.com','fuck-claude.app.evil.test','www.fuck-claude.vercel.app','other.vercel.app']) {
    await verifyOrdinary(outside,`https://${host}/native-scope`);
  }
  await outside.close();
  pass('普通网站、仿冒域名及未列入的 Vercel 网站保持原生 API 和请求头');

  const diagnostic=await context.newPage();await diagnostic.goto('https://outside.test/diagnostics');
  const diagnosticId=await control.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url==='https://outside.test/diagnostics').id);
  traffic.length=0;
  const trace=await diagnostic.evaluate(()=>fetch('https://claude.ai/cdn-cgi/trace?check=1').then(r=>r.text()));
  assert.match(trace,/ip=203\.0\.113\.42/);
  assert.ok(traffic.some(r=>r.host==='claude.ai'&&r.path==='/cdn-cgi/trace'));
  assert.equal(await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),diagnosticId),'');
  for(const [path,method] of [['/api/test','GET'],['/cdn-cgi/trace/extra','GET'],['/cdn-cgi/trace','POST']]){
    traffic.length=0;
    assert.equal(await diagnostic.evaluate(async([path,method])=>{try{await fetch('https://claude.ai'+path,{method});return 'allowed';}catch{return 'blocked';}},[path,method]),'blocked');
    assert.equal(traffic.some(r=>r.host==='claude.ai'),false);
  }
  await wait(async()=>await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),diagnosticId)==='!');
  assert.match(await control.evaluate(id=>chrome.action.getTitle({tabId:id}),diagnosticId),/outside\.test.*claude\.ai.*notme 拦截/);
  const reviewPage=await context.newPage();await reviewPage.goto('chrome-extension://'+id+'/review.html?tab='+diagnosticId);
  const reviewState=await send({type:'NOTME_GUARD_REVIEW',tabId:diagnosticId});
  assert.ok((await send({type:'NOTME_GUARD_ALLOW_REQUESTS',tabId:diagnosticId,reviewId:reviewState.value.id})).error);
  await reviewPage.locator('#allow:enabled').waitFor();
  assert.match(await reviewPage.locator('#source').textContent(),/outside.test/);
  assert.match(await reviewPage.locator('#destinations').textContent(),/claude.ai/);
  const checkedToken=await reviewPage.evaluate(()=>checked.token);
  assert.match((await send({type:'NOTME_GUARD_ALLOW_REQUESTS',tabId:diagnosticId,reviewId:reviewState.value.id,token:checkedToken})).error,/权限/);
  // Grant only the fixture origin through Chrome's extension-management API; no native permission-dialog automation.
  const permissionsPage=await context.newPage();await permissionsPage.goto('chrome://extensions');
  await permissionsPage.evaluate(async extensionId=>chrome.developerPrivate.addHostPermission(extensionId,'https://outside.test/*'),id);
  await permissionsPage.close();
  await reviewPage.locator('#allow').click();await wait(async()=>/已临时允许/.test(await reviewPage.locator('#result').textContent()));
  traffic.length=0;
  await diagnostic.evaluate(()=>fetch('https://claude.ai/api/test',{mode:'no-cors'}));
  const reviewedRequest=traffic.find(r=>r.host==='claude.ai'&&r.path==='/api/test');
  assert.equal(reviewedRequest.language,'en-US,en;q=0.9');assert.ok(!reviewedRequest.ua.includes('HeadlessChrome'));
  assert.equal(await diagnostic.evaluate(()=>navigator.language),original.language);
  const isolated=await context.newPage();await isolated.goto('https://outside.test/isolated');
  traffic.length=0;await isolated.evaluate(()=>fetch('https://claude.ai/api/test',{mode:'no-cors'}).catch(()=>{}));
  assert.equal(traffic.some(r=>r.host==='claude.ai'),false);await isolated.close();
  await reviewPage.locator('#language').uncheck();await reviewPage.locator('#identity').uncheck();
  await reviewPage.locator('#allow:enabled').waitFor();await reviewPage.locator('#allow').click();
  await wait(async()=>/已临时允许/.test(await reviewPage.locator('#result').textContent()));
  traffic.length=0;await diagnostic.evaluate(()=>fetch('https://claude.ai/api/test',{mode:'no-cors'}));
  assert.ok(traffic.find(r=>r.host==='claude.ai').language.startsWith(original.language));
  assert.ok(traffic.find(r=>r.host==='claude.ai').ua.includes('HeadlessChrome'));
  policies.set('claude.ai',{country:'CN'});await reviewPage.locator('#retry').click();
  await wait(async()=>Boolean(await reviewPage.locator('#error').textContent()));
  assert.equal(await reviewPage.locator('#allow').isEnabled(),false);
  traffic.length=0;await diagnostic.evaluate(()=>fetch('https://claude.ai/api/test',{mode:'no-cors'}).catch(()=>{}));
  assert.equal(traffic.some(r=>r.host==='claude.ai'),false);policies.delete('claude.ai');
  traffic.length=0;
  await diagnostic.evaluate(()=>fetch('https://anthropic.com/api/test',{mode:'no-cors'}).catch(()=>{}));
  assert.equal(traffic.some(r=>r.host==='anthropic.com'),false);
  await diagnostic.goto('https://outside.test/clean');
  traffic.length=0;
  await diagnostic.evaluate(()=>fetch('https://claude.ai/api/test',{mode:'no-cors'}).catch(()=>{}));
  assert.equal(traffic.some(r=>r.host==='claude.ai'),false);
  const stale=await send({type:'NOTME_GUARD_ALLOW_REQUESTS',tabId:diagnosticId,reviewId:'stale',destinations:['claude.ai']});
  assert.ok(stale.error);await reviewPage.close();
  await diagnostic.goto('https://outside.test/clean-again');
  await wait(async()=>await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),diagnosticId)==='');
  traffic.length=0;
  await diagnostic.evaluate(()=>{location.href='https://claude.ai/oauth/callback?code=synthetic&state=synthetic';});
  await wait(async()=>diagnostic.url().startsWith('chrome-extension://'+id+'/gate.html') && diagnostic.url().includes('#target='));
  await wait(async()=>diagnostic.locator('#retry').isEnabled());
  assert.match(await diagnostic.locator('#target').textContent(),/oauth\/callback\?code=synthetic&state=synthetic/);
  assert.equal(formalRequests().length,0);
  await confirm(diagnostic);
  assert.ok(traffic.some(r=>r.host==='claude.ai'&&r.path==='/oauth/callback'));
  traffic.length=0;
  await diagnostic.goto('https://outside.test/oauth-redirect').catch(()=>{});
  await wait(async()=>diagnostic.url().includes('/gate.html')&&diagnostic.url().includes('#target='));
  await wait(async()=>diagnostic.locator('#retry').isEnabled());
  assert.equal(await diagnostic.locator('#target').textContent(),'https://claude.ai/oauth/redirected?code=synthetic%26code&state=synthetic%3Dstate&extra=1');
  assert.equal(formalRequests().length,0);await confirm(diagnostic);
  assert.equal(new URL(diagnostic.url()).search,'?code=synthetic%26code&state=synthetic%3Dstate&extra=1');
  await diagnostic.close();
  pass('第三方请求可审核临时放行，仅允许审核域名，导航后撤销；第三方授权回调正常进入检查页并保留参数');

  const verification = await context.newPage();
  for (const host of Network.VERIFICATION_DOMAINS) {
    traffic.length=0;await openGate(verification,`https://${host}/verification-choice#scan`);
    assert.equal(formalRequests().length,0);
    assert.equal(traffic.some(item=>item.host===host),false);
    assert.match(await checkDetails(verification),/检测 Claude 网络出口/);
    assert.ok(traffic.some(item=>item.host==='claude.ai'&&item.path.startsWith('/cdn-cgi/trace')));
    assert.match(await verification.locator('#target-network').textContent(),/claude\.ai/);
    assert.match(await verification.locator('#environment-info').textContent(),/claude\.ai/);
    await confirm(verification);
    assert.deepEqual(await verification.evaluate(()=>({language:window.first.language,zone:window.first.zone,hash:window.first.hash})),
      {language:'en-US',zone:'America/Los_Angeles',hash:'#scan'});
    assert.equal(traffic.findLast(item=>item.host===host&&item.path==='/verification-choice').language,'en-US,en;q=0.9');
    assert.equal(await rtc(verification),'NotAllowedError');
    assert.deepEqual(await deniedLocation(verification),{get:1,watch:1,permission:'denied'});
    const widths=await fontWidths(verification);assert.equal(widths.custom,widths.generic);
  }
  pass('两个检测站先选择并确认本次环境，确认前对检测站零请求，首个脚本及请求头已使用伪装');

  traffic.length=0;await worker.evaluate(()=>{Date.originalNow=Date.now;Date.now=()=>Date.originalNow()+86400001;});await verification.reload();
  await wait(async()=>verification.url().startsWith(`chrome-extension://${id}/gate.html`)&&await verification.locator('#retry').isEnabled());
  assert.equal(formalRequests().length,0);assert.equal(await verification.locator('#formal').count(),0);
  await preset(verification,'全部使用系统默认');await confirm(verification);
  assert.deepEqual(await verification.evaluate(()=>({language:window.first.language,zone:window.first.zone,ua:window.first.ua})),original);
  assert.deepEqual(await location(verification),{lat:31.23,lon:121.47});
  assert.deepEqual(await workerProfile(verification),baselineWorker);assert.equal(await rtc(verification),'allowed');
  const nativeWidths=await fontWidths(verification);assert.notEqual(nativeWidths.custom,nativeWidths.generic);
  assert.ok(traffic.findLast(item=>item.host==='fuck-claude.app'&&item.path==='/verification-choice').language.startsWith(original.language));
  await worker.evaluate(()=>{Date.now=Date.originalNow;});
  pass('检测站超过一天后刷新重新选择，全部系统默认保留首个脚本、GPS、Worker、字体、WebRTC 和请求头的原生值');

  traffic.length=0;await openGate(verification,'https://fuck-claude.app/verification-mixed');
  await select(verification,'语言与请求头','系统默认');await select(verification,'后台脚本（Web Worker）','伪装');
  assert.equal(formalRequests().length,0);await confirm(verification);
  assert.equal((await verification.evaluate(()=>window.first)).language,original.language);
  assert.equal((await verification.evaluate(()=>window.first)).zone,'America/Los_Angeles');
  assert.ok(traffic.findLast(item=>item.host==='fuck-claude.app'&&item.path==='/verification-mixed').language.startsWith(original.language));
  await workerProfile(verification);await wait(async()=>(await workerProfile(verification)).zone==='America/Los_Angeles');
  pass('进入检测站前逐项选择，语言用系统默认而时区及 Worker 伪装，本次选择无需保存默认');

  const secondVerification=await context.newPage();traffic.length=0;
  await openGate(secondVerification,'https://fuck-claude.vercel.app/verification-independent');
  assert.equal(await secondVerification.locator('input[name="langEnabled"][value="spoof"]').isChecked(),true);
  await preset(secondVerification,'全部使用系统默认');await confirm(secondVerification);
  assert.equal((await secondVerification.evaluate(()=>window.first)).zone,original.zone);
  assert.equal(await verification.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone),'America/Los_Angeles');
  await send({type:'SET_SETTINGS',patch:{guardDefaults:Object.fromEntries(['enabled','tzEnabled','langEnabled','identityEnabled','fontEnabled','workerEnabled','webrtcProtect'].map(key=>[key,false]))}});
  assert.equal(await verification.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone),'America/Los_Angeles');
  await send({type:'SET_SETTINGS',patch:{guardDefaults:null}});await secondVerification.close();await verification.close();
  pass('检测站标签页各用本次配置，不覆盖默认或其他标签页，修改默认也不覆盖已确认环境');

  policies.set('reallyfreegeoip.org',{country:'CN',ip:'203.0.113.99'});
  const blockedVerification=await context.newPage();traffic.length=0;
  await openGate(blockedVerification,'https://fuck-claude.app/verification-blocked');
  await preset(blockedVerification,'全部使用系统默认');
  assert.equal(await blockedVerification.locator('#confirm').isEnabled(),false);assert.equal(formalRequests().length,0);
  policies.delete('reallyfreegeoip.org');await blockedVerification.close();
  pass('检测站进入前发现大陆出口时禁止确认，系统默认不能绕过，正式页面保持零请求');

  traffic.length = 0;
  await page.reload().catch(()=>{});await page.locator('#formal').waitFor();
  assert.equal(traffic.some(r=>r.path==='/cdn-cgi/trace'),false);
  assert.equal(await page.evaluate(()=>window.first.language),'en-US');
  traffic.length=0;
  await page.goto('https://claude.ai/same-day?preserved=1#hash').catch(()=>{});await page.locator('#formal').waitFor();
  assert.equal(traffic.some(r=>r.path==='/cdn-cgi/trace'),false);
  assert.equal(await page.evaluate(()=>window.first.hash),'#hash');
  await worker.evaluate(()=>{Date.originalNow=Date.now;Date.now=()=>Date.originalNow()+86400001;});
  traffic.length=0;await page.reload().catch(()=>{});
  await wait(async () => page.url().startsWith(`chrome-extension://${id}/gate.html`) && await page.locator('#retry').isEnabled());
  await worker.evaluate(()=>{Date.now=Date.originalNow;});
  assert.equal(formalRequests().length,0);await confirm(page);
  pass('同标签同域刷新及跳转一天内复用环境且不发探测请求，超过一天重新检查');
  traffic.length=0;
  const activeId=await control.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.includes('/same-day')).id);
  await worker.evaluate(async tabId=>NotmeGuard.recheck(await chrome.tabs.get(tabId)),activeId);
  await wait(async()=>page.url().includes('/gate.html')&&await page.locator('#retry').isEnabled());
  assert.equal(formalRequests().length,0);assert.ok(traffic.some(r=>r.path==='/cdn-cgi/trace'));await confirm(page);
  pass('保护页点击扩展图标可手动重新检查，不复用当天结果');

  traffic.length = 0;
  const another = await context.newPage();
  await openGate(another, 'https://claude.ai/another');
  assert.equal(formalRequests().length, 0);
  pass('新标签页访问同域不会复用另一标签页的放行');

  const cached = await context.newPage();
  await openGate(cached, 'https://claude.ai/cached'); await confirm(cached);
  traffic.length = 0;
  await openGate(another, 'https://claude.ai/cached');
  assert.equal(formalRequests().length, 0);
  assert.equal(await another.locator('#formal').count(), 0);
  pass('普通 HTTP 缓存中的正式页面也被网络闸门拦截');
  await cached.close();

  for (const root of Network.ROOT_DOMAINS) {
    traffic.length = 0;
    await openGate(another, `https://brandnew.deep.${root}/new`);
    assert.equal(formalRequests().length, 0);
    assert.equal(await another.locator('#confirm').isEnabled(), true);
  }
  pass('所有 Anthropic 主域及新生成的多层子域都受主页面闸门保护');

  policies.set('claude.ai', { country: 'HK' });
  traffic.length = 0; await openGate(another, 'https://claude.ai/blocked');
  assert.equal(await another.locator('#confirm').isEnabled(), false); assert.equal(formalRequests().length, 0);
  pass('受限地区无法确认进入，保持零正式网站请求');
  policies.set('claude.ai', { invalid: true });
  traffic.length = 0; await openGate(another, 'https://claude.ai/unknown');
  assert.equal(await another.locator('#confirm').isEnabled(), false); assert.equal(formalRequests().length, 0);
  pass('目标出口未知时无法生成所选的自动伪装环境');

  policies.delete('claude.ai');
  await send({ type: 'SET_SETTINGS', patch: { manualTz: 'Asia/Tokyo' } });
  traffic.length = 0; await openGate(another, 'https://claude.ai/manual');
  assert.equal(formalRequests().length, 0); await confirm(another);
  assert.equal((await another.evaluate(() => window.first)).zone, 'Asia/Tokyo');
  assert.equal((await another.evaluate(() => window.first)).language, 'ja-JP');
  pass('伪装沿用 notme 手动时区流程，不替用户强改已选时区');
  await send({ type: 'SET_SETTINGS', patch: { manualTz: '' } });

  traffic.length = 0; await openGate(another, 'https://claude.ai/settings-changed');
  await send({ type: 'SET_SETTINGS', patch: { manualTz: 'Asia/Tokyo' } });
  await another.getByRole('button', { name: '确认并访问', exact: true }).click();
  await another.locator('#error').getByText('notme 设置已变化，请重新检查并确认').waitFor();
  assert.equal(formalRequests().length, 0);
  pass('检查通过后修改设置也会使确认失效，不发送正式页面请求');
  await send({ type: 'SET_SETTINGS', patch: { manualTz: '' } });

  traffic.length = 0; await openGate(another, 'https://claude.ai/changed');
  policies.set('claude.ai', { country: 'JP', ip: '203.0.113.43' });
  await ageCheck(another);
  await confirm(another);
  assert.equal((await another.evaluate(()=>window.first)).zone,'Asia/Tokyo');
  assert.equal((await another.evaluate(()=>window.first)).language,'ja-JP');
  pass('确认前出口换成另一个非限制地区时重新检查并更新环境，不因 IP 不同拒绝访问');

  policies.delete('claude.ai'); policies.set('platform.claude.com', { country: 'JP', ip: '203.0.113.43' });
  await openGate(another, 'https://platform.claude.com/japan'); await confirm(another);
  assert.equal((await another.evaluate(() => window.first)).zone, 'Asia/Tokyo');
  assert.equal((await another.evaluate(() => window.first)).language, 'ja-JP');
  assert.equal((await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)), 'America/Los_Angeles');
  assert.ok(traffic.find(item => item.host === 'platform.claude.com' && item.path === '/japan').language.startsWith('ja-JP'));
  pass('分流到不同地区的标签页使用各自环境，不被全局刷新覆盖');

  traffic.length = 0; await openGate(another, 'https://claude.ai/native');
  await preset(another, '全部使用系统默认');
  assert.equal(formalRequests().length, 0);
  assert.equal(await another.locator('#choices input[value="native"]:checked').count(), 7);
  await confirm(another);
  assert.deepEqual(await another.evaluate(() => ({ language:window.first.language, zone:window.first.zone, ua:window.first.ua })), original);
  const nativeHeaders = formalRequests().find(item => item.path === '/native');
  assert.equal(nativeHeaders.ua, original.ua);
  assert.ok(nativeHeaders.language.startsWith(original.language));
  assert.deepEqual(await location(another), { lat:31.23, lon:121.47 });
  const frameProfile = await another.evaluate(async () => {
    const frame = document.createElement('iframe'); frame.src = 'about:blank';
    const loaded = new Promise(resolve => frame.onload = resolve); document.body.append(frame); await loaded;
    await new Promise(resolve => setTimeout(resolve,200));
    return { language:frame.contentWindow.navigator.language,zone:frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone };
  });
  assert.deepEqual(frameProfile, { language:original.language,zone:original.zone });
  const nativeWorker = await workerProfile(another);
  const nativeFont = await fontWidths(another); assert.notEqual(nativeFont.custom, nativeFont.generic);
  assert.notEqual((await control.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}))).levelOfControl, 'controlled_by_this_extension');
  assert.equal(await rtc(another),'allowed');
  pass('全部系统默认保留主页面与空白子框架的原生环境、GPS、字体、Worker 和请求头，WebRTC 还原默认');

  const cases = [
    ['地理位置', async page => assert.deepEqual(await location(page), {lat:31.23,lon:121.47})],
    ['时区', async page => assert.equal((await page.evaluate(() => window.first)).zone, original.zone)],
    ['语言与请求头', async page => {
      assert.equal((await page.evaluate(() => window.first)).language, original.language);
      assert.equal(formalRequests().at(0).language, nativeHeaders.language);
    }],
    ['浏览器与设备标识', async page => {
      assert.equal((await page.evaluate(() => window.first)).ua, original.ua);
      assert.equal(formalRequests().at(0).ua, nativeHeaders.ua);
    }],
    ['字体', async page => { const width = await fontWidths(page); assert.notEqual(width.custom, width.generic); }],
    ['后台脚本（Web Worker）', async page => assert.deepEqual(await workerProfile(page), nativeWorker)],
    ['IP 防泄漏（WebRTC）', async page => assert.equal(await rtc(page),'allowed')],
  ];
  for (const [label, verify] of cases) {
    traffic.length = 0; await openGate(another, 'https://claude.ai/mixed');
    await select(another, label, '系统默认');
    assert.equal(formalRequests().length, 0); await confirm(another); await verify(another);
    const first = await another.evaluate(() => window.first);
    if (label !== '时区') assert.equal(first.zone, 'America/Los_Angeles');
    if (label !== '语言与请求头') assert.equal(first.language, 'en-US');
    if (label !== '浏览器与设备标识') assert.ok(!first.ua.includes('HeadlessChrome'));
    pass(`单独将${label}设为系统默认，其他伪装仍生效`);
  }
  await openGate(another, 'https://claude.ai/worker-spoof');
  await select(another, '后台脚本（Web Worker）', '伪装'); await confirm(another);
  await workerProfile(another); await another.waitForTimeout(200);
  assert.deepEqual(await workerProfile(another), { zone:'America/Los_Angeles',language:'en-US' });
  const hiddenFont = await fontWidths(another); assert.equal(hiddenFont.custom, hiddenFont.generic);
  pass('主动开启 Worker 伪装后使用所选时区语言；字体伪装能隐藏已加载的地区字体');

  await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.set({value:'disable_non_proxied_udp'}));
  const beforeRestricted=udpRequests;
  await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.set({value:'disable_non_proxied_udp'}));
  await openGate(another,'https://claude.ai/udp-protected');
  assert.ok((await checkDetails(another)).includes('未发送 STUN'));
  assert.equal(udpRequests,beforeRestricted);assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.ok((await checkDetails(another)).includes('WebRTC 防泄漏保护已生效'));
  pass('实际 WebRTC 保护已生效时显示防护通过，且不发送任何 STUN 包');

  await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.clear({}));
  await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.clear({}));
  traffic.length=0;await openGate(another,'https://claude.ai/udp-match');
  assert.ok((await checkDetails(another)).includes('与目标站出口相同'));
  assert.ok(udpRequests>beforeRestricted);assert.equal(formalRequests().length,0);
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.ok((await checkDetails(another)).includes('目标站出口'));
  assert.ok((await checkDetails(another)).includes('HTTP/2'));
  const fallbackCard=await another.locator('#cloudflare-network').innerText();
  assert.match(fallbackCard,/203\.0\.113\.42/);assert.match(fallbackCard,/HTTP\/2/);
  assert.equal((fallbackCard.match(/HTTP\/3 未验证/g)||[]).length,1);
  assert.doesNotMatch(await another.locator('#target-network').innerText(),/Cloudflare|HTTP\/3 未验证/);
  assert.doesNotMatch(await checkDetails(another),/查 IP 服务出口/);
  assert.equal(await another.evaluate(()=>document.querySelector('#diagnostics').getBoundingClientRect().top<document.querySelector('#choices').getBoundingClientRect().top),true);
  assert.ok(await another.evaluate(()=>parseFloat(getComputedStyle(document.body).fontSize)>=16));
  assert.equal(await another.locator('#checks .network-card').count(),3);
  await another.setViewportSize({width:390,height:844});
  assert.equal(await another.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await another.setViewportSize({width:1100,height:1050});
  await mkdir('test-results',{recursive:true});await another.screenshot({path:'test-results/network-preview.png',clip:{x:0,y:0,width:1100,height:930}});
  pass('真实浏览器经本地 UDP/STUN 收到响应；HTTP/2 和 Alt-Svc 不会误报 HTTP/3');
  pass('网络检查置顶、字体清晰且窄屏不横向溢出，HTTP/2 回退仍显示 Cloudflare 出口，状态与来源不重复');

  udpIP='203.0.113.99';traffic.length=0;await openGate(another,'https://claude.ai/udp-different');
  assert.match(await checkDetails(another),/203\.0\.113\.99/);
  assert.equal(formalRequests().length,0);assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.ok((await another.locator('#checks .check').filter({hasText:'UDP / STUN'}).getAttribute('class')).includes('info'));
  pass('UDP 与 HTTPS 出口不同只显示第三方分流参考，不判为异常，确认前零正式请求');

  for (const country of ['CN','HK']) {
    policies.set('ipwho.is/203.0.113.99',{country});
    traffic.length=0;await openGate(another,`https://claude.ai/stun-${country}`);
    assert.equal(await another.locator('#confirm').isEnabled(),false);
    assert.match(await checkDetails(another),/禁止访问/);
    assert.ok((await another.locator('#udp-network').getAttribute('class')).includes('fail'));
    assert.equal(formalRequests().length,0);
  }
  policies.delete('ipwho.is/203.0.113.99');
  pass('目标站出口正常时，STUN 地区查询发现任一中国大陆或香港出口仍禁止访问');

  policies.set('ipwho.is/203.0.113.99',{country:'CN',delayMs:800});
  await another.goto('https://claude.ai/stun-region-pending').catch(error=>{if(!/ERR_ABORTED|ERR_FAILED/.test(error.message))throw error;});
  await wait(async()=>another.url().startsWith(`chrome-extension://${id}/gate.html`));
  await another.getByRole('button',{name:'确认并访问',exact:true}).waitFor();
  const pendingTab=await another.evaluate(async()=> (await chrome.tabs.getCurrent()).id);
  let pendingView;
  await wait(async()=>{pendingView=(await send({type:'NOTME_GUARD_STATE',tabId:pendingTab})).value;return !!pendingView?.report && !pendingView.report.diagnosticsComplete;});
  assert.equal(pendingView.report.ready,false);
  const premature=await send({type:'NOTME_GUARD_CONFIRM',tabId:pendingTab,navigationId:pendingView.navigationId,
    selection:pendingView.override,udp:{state:'unknown',ips:[]}});
  assert.match(premature.error,/环境检查未通过/);
  await wait(async()=>await another.locator('#retry').isEnabled());
  assert.equal(await another.locator('#confirm').isEnabled(),false);
  assert.equal(formalRequests().length,0);
  policies.delete('ipwho.is/203.0.113.99');udpIP='203.0.113.42';
  pass('STUN 地区查询未完成前无法提前确认，查询到大陆 IP 后仍保持正式请求为零');

  udpRespond=false;await openGate(another,'https://claude.ai/udp-timeout');
  assert.ok((await checkDetails(another)).includes('未取得 STUN 响应'));
  assert.equal(await another.locator('#confirm').isEnabled(),true);udpRespond=true;udpIP='203.0.113.42';
  pass('STUN 超时报告 UDP 未验证，不假定网络故障或阻止正常 HTTPS 访问');

  policies.set('claude.ai',{protocol:'http/3'});await openGate(another,'https://claude.ai/h3-observed');
  assert.ok((await checkDetails(another)).includes('HTTP/3'));
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  policies.delete('claude.ai');await send({type:'SET_SETTINGS',patch:{webrtcProtect:true}});
  pass('HTTP/3 仅根据目标 trace 的实际协议字段显示已验证');

  policies.set(Network.HTTP3_TEST_HOST,{protocol:'http/3'});
  traffic.length=0;await openGate(another,'https://claude.ai/third-party-h3-match');
  assert.match(await another.locator('#environment-info').textContent(),/目标站 claude.ai 的 HTTPS 请求出口/);
  await checkDetails(another);
  const thirdPartyExit=another.locator('#cloudflare-network');
  assert.match(await another.locator('#target-network').innerText(),/203\.0\.113\.42/);
  assert.match(await thirdPartyExit.innerText(),/203\.0\.113\.42/);
  assert.match(await thirdPartyExit.innerText(),/与目标站出口相同/);
  assert.match(await thirdPartyExit.innerText(),/HTTP\/3 已验证/);assert.match(await another.locator('.network-note').innerText(),/第三方测试路径/);
  assert.ok((await thirdPartyExit.getAttribute('class')).includes('ok'));
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.ok(traffic.some(item=>item.host===Network.HTTP3_TEST_HOST && item.path==='/cdn-cgi/trace' && !item.cookie));
  assert.equal(formalRequests().length,0);
  pass('第三方 HTTP/3 与目标 TCP 出口一致时绿色展示两边 IP 和参考范围，确认前零正式请求');

  policies.set(Network.HTTP3_TEST_HOST,{protocol:'http/3',ip:'203.0.113.99'});
  await openGate(another,'https://claude.ai/third-party-h3-difference');
  await checkDetails(another);
  assert.match(await thirdPartyExit.innerText(),/203\.0\.113\.99/);
  assert.match(await thirdPartyExit.innerText(),/与目标站出口不同/);
  assert.ok((await thirdPartyExit.getAttribute('class')).includes('info'));
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.equal(formalRequests().length,0);
  pass('第三方 HTTP/3 出口差异只作分流参考，保留正常 HTTPS 确认流程');

  for (const protocol of ['http/2','http/3']) {
    for (const country of ['CN','HK']) {
      policies.set(Network.HTTP3_TEST_HOST,{protocol,country,ip:'203.0.113.99'});
      traffic.length=0;await openGate(another,`https://claude.ai/third-party-${protocol.replace('/','-')}-${country}`);
      assert.equal(await another.locator('#confirm').isEnabled(),false);
      assert.match(await checkDetails(another),/禁止访问/);
      assert.equal(formalRequests().length,0);
    }
  }
  policies.delete(Network.HTTP3_TEST_HOST);
  pass('第三方测试站的 HTTP/3 或 HTTP/2 回退出口出现大陆或香港 IP 都禁止访问');

  for (const country of ['CN','HK']) {
    policies.set('reallyfreegeoip.org',{country,ip:'203.0.113.99'});
    traffic.length=0;await openGate(another,`https://claude.ai/default-ip-${country}`);
    await preset(another,'全部使用系统默认');
    assert.equal(await another.locator('#confirm').isEnabled(),false);
    assert.match(await checkDetails(another),/第三方查 IP 服务/);
    assert.match(await checkDetails(another),/禁止访问/);
    assert.equal(formalRequests().length,0);
  }
  policies.delete('reallyfreegeoip.org');
  pass('第三方通用查 IP 服务发现大陆或香港出口也禁止访问，系统默认选择不能跳过地区规则');

  policies.set('reallyfreegeoip.org',{country:'CN',ip:'not-an-ip'});
  await openGate(another,'https://claude.ai/invalid-ip-region');
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  assert.doesNotMatch(await checkDetails(another),/not-an-ip/);
  assert.doesNotMatch(await checkDetails(another),/查 IP 服务出口/);
  policies.delete('reallyfreegeoip.org');
  pass('查 IP 服务的无效地址不触发大陆封禁，其他有效来源仍可完成检查');

  traffic.length=0;await openGate(another,'https://claude.ai/confirm-third-party-region');
  policies.set(Network.HTTP3_TEST_HOST,{protocol:'http/2',country:'HK',ip:'203.0.113.99'});
  await ageCheck(another);
  await another.getByRole('button',{name:'确认并访问',exact:true}).click();
  await another.locator('#error').getByText('检测到中国大陆 / 香港出口，禁止访问；请重新检查').waitFor();
  assert.equal(await another.locator('#confirm').isEnabled(),false);
  assert.equal(formalRequests().length,0);
  policies.delete(Network.HTTP3_TEST_HOST);
  pass('确认时重复检查全部来源，第三方出口在确认前变成香港会被拦截');

  udpIP='203.0.113.99';
  traffic.length=0;await openGate(another,'https://claude.ai/confirm-stun-region');
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  policies.set('ipwho.is/203.0.113.99',{country:'CN'});
  await ageCheck(another);
  await another.getByRole('button',{name:'确认并访问',exact:true}).click();
  await another.locator('#error').getByText('检测到中国大陆 / 香港出口，禁止访问；请重新检查').waitFor();
  assert.equal(await another.locator('#confirm').isEnabled(),false);
  assert.equal(formalRequests().length,0);
  policies.delete('ipwho.is/203.0.113.99');udpIP='203.0.113.42';
  pass('确认时重新探测 STUN 并查询地区，同一个 UDP IP 的新查询结果变成大陆也立即拦截');

  policies.set(Network.HTTP3_TEST_HOST,{invalid:true});
  await openGate(another,'https://claude.ai/third-party-h3-unknown');
  await checkDetails(another);
  assert.match(await thirdPartyExit.innerText(),/HTTP\/3 未验证/);
  assert.ok((await thirdPartyExit.getAttribute('class')).includes('info'));
  assert.equal(await another.locator('#confirm').isEnabled(),true);
  policies.delete(Network.HTTP3_TEST_HOST);
  pass('第三方探测响应无效时保持未验证，不冒充 HTTP/3 出口一致');
  await preset(another,'使用 notme 伪装');

  traffic.length=0;await openGate(another,'https://claude.ai/inline-settings');
  assert.equal(await another.locator('#advanced').evaluate(node => node.open),false);
  assert.equal(await another.locator('#diagnostics').evaluate(node => node.open),true);
  await another.locator('#manualTz').selectOption('Asia/Tokyo');
  await wait(async () => (await send({type:'GET_STATE'})).settings.manualTz === 'Asia/Tokyo' && await another.locator('#retry').isEnabled());
  assert.ok((await another.locator('#detail-tzEnabled').innerText()).includes('Asia/Tokyo'));
  assert.equal(formalRequests().length,0);await confirm(another);
  assert.equal((await another.evaluate(() => window.first)).zone,'Asia/Tokyo');
  assert.equal((await another.evaluate(() => window.first)).language,'ja-JP');
  pass('在环境选择页直接修改时区，自动保存并重新检查；确认前零正式请求，首个脚本使用新时区与语言');

  await openGate(another,'https://claude.ai/advanced-settings');
  await select(another,'地理位置','伪装');
  await another.locator('#advanced > summary').click();
  const beforePreferences=(await send({type:'GET_STATE'})).settings;
  policies.set('claude.ai',{delayMs:150});
  const beforeSlowCheck=traffic.filter(item => item.host === 'claude.ai' && item.path === '/cdn-cgi/trace').length;
  await another.locator('#retry').click();
  await wait(async () => traffic.filter(item => item.host === 'claude.ai' && item.path === '/cdn-cgi/trace').length > beforeSlowCheck);
  await another.locator('#accuracyM').fill('45');await another.locator('#accuracyM').blur();
  await wait(async () => (await send({type:'GET_STATE'})).settings.accuracyM === 45 && await another.locator('#retry').isEnabled());
  const afterPreferences=(await send({type:'GET_STATE'})).settings;
  assert.equal(afterPreferences.refreshMinutes,beforePreferences.refreshMinutes);
  assert.equal(afterPreferences.networkWarnMs,beforePreferences.networkWarnMs);
  assert.equal(afterPreferences.ipToken,beforePreferences.ipToken);
  assert.equal(await another.locator('#ipToken').getAttribute('type'),'password');
  policies.delete('claude.ai');
  await confirm(another);
  const accuracy=await another.evaluate(() => new Promise(resolve => navigator.geolocation.getCurrentPosition(p => resolve(p.coords.accuracy))));
  assert.ok(accuracy >= 41 && accuracy <= 49,`定位精度应以 45 米为中心，实际为 ${accuracy}`);
  pass('检查过程中修改高级参数会重做检查并使用新定位精度；其他参数保留，Token 隐藏');

  await openGate(another,'https://claude.ai/save-defaults');
  await preset(another,'全部使用系统默认');await another.locator('#save-defaults').click();
  await wait(async () => (await another.locator('#saved').innerText()).includes('已保存默认环境') && await another.locator('#retry').isEnabled());
  const remembered=await context.newPage();traffic.length=0;
  await openGate(remembered,'https://claude.ai/remembered');
  assert.equal(await remembered.locator('#choices input[value="native"]:checked').count(),7);
  assert.equal(formalRequests().length,0);await confirm(remembered);
  assert.deepEqual(await remembered.evaluate(() => ({language:window.first.language,zone:window.first.zone,ua:window.first.ua})),original);
  await preset(another,'使用 notme 伪装');
  assert.equal(await another.locator('#choices input[value="spoof"]:checked').count(),5);
  await another.locator('#save-defaults').click();
  await wait(async()=>await another.locator('#retry').isEnabled());
  const afterSave=await context.newPage();await verifyOrdinary(afterSave,'https://outside.test/after-save');await afterSave.close();
  await remembered.close();
  pass('保存默认选择后新访问预选相同开关，仍需确认；伪装预设可恢复，系统默认不强制伪装');
  pass('保存伪装默认环境也不改普通网站的任何浏览器信号');

  const reset=Object.fromEntries(['enabled','tzEnabled','langEnabled','fontEnabled','webrtcProtect'].map(key => [key,true]));
  await send({type:'SET_SETTINGS',patch:{...reset,manualTz:'',accuracyM:30,guardDefaults:null,workerEnabled:false}});

  await send({type:'SET_SETTINGS',patch:{accuracyM:45}});
  const savedDefaults=Object.fromEntries(['enabled','tzEnabled','langEnabled','identityEnabled','fontEnabled','workerEnabled','webrtcProtect']
    .map(key=>[key,!['workerEnabled','identityEnabled'].includes(key)]));
  await send({type:'SET_SETTINGS',patch:{guardDefaults:savedDefaults}});
  await control.evaluate(async()=>{
    const {settings}=await chrome.storage.local.get('settings');
    await chrome.storage.local.set({settings:{...settings,enabled:true,tzEnabled:true,langEnabled:true,fontEnabled:true,identityEnabled:true,workerEnabled:true,webrtcProtect:true}});
    await chrome.storage.session.set({guardWebRTCProtect:true});
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({value:'disable_non_proxied_udp'});
    await chrome.declarativeNetRequest.updateDynamicRules({addRules:[9001,9002,9003,9004,9005,19000,19001].map(id=>({
      id,priority:1000,action:{type:'modifyHeaders',requestHeaders:[{header:'accept-language',operation:'set',value:'en-US,en;q=0.9'}]},
      condition:{urlFilter:'*',resourceTypes:['main_frame','sub_frame','xmlhttprequest']},
    }))});
  });
  await control.evaluate(()=>chrome.storage.local.remove('targetExitRecords'));
  const exitPage=await context.newPage();
  await openGate(exitPage,'https://claude.ai/exit-first');
  assert.match(await exitPage.locator('#target-network').textContent(),/首次记录/);
  policies.set('claude.ai',{ip:'203.0.113.43',country:'JP'});
  await openGate(exitPage,'https://claude.ai/exit-changed');
  assert.match(await exitPage.locator('.exit-change').textContent(),/203\.0\.113\.42 → 203\.0\.113\.43/);
  assert.equal(await exitPage.locator('#exit-alert').isVisible(),true);
  assert.equal(await exitPage.locator('#exit-alert-before').textContent(),'203.0.113.42');
  assert.equal(await exitPage.locator('#exit-alert-after').textContent(),'203.0.113.43');
  assert.ok(await exitPage.evaluate(()=>document.querySelector('#exit-alert').getBoundingClientRect().top < document.querySelector('#diagnostics').getBoundingClientRect().top));
  assert.equal(await exitPage.locator('#confirm').isEnabled(),true);
  await exitPage.locator('#retry').click();await wait(async()=>await exitPage.locator('#retry').isEnabled());
  assert.equal(await exitPage.locator('.exit-change').count(),1);
  assert.equal(await exitPage.locator('.exit-history li').count(),2);
  policies.set('claude.ai',{invalid:true});
  await openGate(exitPage,'https://claude.ai/exit-failed');
  assert.equal(await control.evaluate(async()=> (await chrome.storage.local.get('targetExitRecords')).targetExitRecords['claude.ai'][0].ip),'203.0.113.43');
  policies.set('claude.ai',{ip:'203.0.113.43',country:'JP'});
  await openGate(exitPage,'https://claude.ai/exit-same');
  assert.equal(await exitPage.locator('.exit-change').count(),0);
  assert.match(await exitPage.locator('#target-network').textContent(),/与上次相同/);
  assert.equal(await exitPage.locator('#exit-alert').isVisible(),false);
  await openGate(exitPage,'https://www.anthropic.com/exit-independent');
  assert.match(await exitPage.locator('#target-network').textContent(),/首次记录/);
  for(let i=0;i<10;i++) await openGate(exitPage,'https://claude.ai/history-'+i);
  assert.equal(await exitPage.locator('.exit-history li').count(),10);
  assert.equal(await control.evaluate(async()=> (await chrome.storage.local.get('targetExitRecords')).targetExitRecords['claude.ai'].length),10);
  await exitPage.close();policies.delete('claude.ai');
  pass('按域名记录出口，变化提醒不阻断，同次重检保留提醒，失败不覆盖记录，各域名独立');
  const recoveryTargets=['https://claude.ai/chat/restore-one?x=1#anchor','https://www.anthropic.com/restore-two?x=2#section'];
  const recoveryURLs=[];
  for(const target of recoveryTargets){
    const page=await context.newPage();await openGate(page,target);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('target'),target);
    recoveryURLs.push(page.url());
  }
  const relocated=join(temporary,'moved-extension');await mkdir(relocated);
  for(const file of ['manifest.json','background.js','content-bridge.js','content-inject.js','guard-rules.json','gate.html','gate.css','gate.js','lib','icons']) {
    await cp(resolve(file),join(relocated,file),{recursive:true});
  }
  await context.close();
  context=await chromium.launchPersistentContext(join(temporary,'profile'),{
    ...options,args:[...options.args,`--disable-extensions-except=${relocated}`,`--load-extension=${relocated}`],
  });
  await redirectStun(context);await context.grantPermissions(['geolocation']);
  const movedWorker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension:'))
    || await context.waitForEvent('serviceworker',{predicate:worker=>worker.url().startsWith('chrome-extension:')});
  assert.equal(new URL(movedWorker.url()).hostname,id);
  control=await context.newPage();await control.goto(`chrome-extension://${id}/gate.html?settings`);
  for(let i=0;i<recoveryURLs.length;i++){
    traffic.length=0;const page=await context.newPage();await page.goto(recoveryURLs[i]);
    await wait(async()=>await page.locator('#retry').isEnabled());
    assert.equal(await page.locator('#target').textContent(),recoveryTargets[i]);
    assert.equal(await page.locator('#confirm').isVisible(),true);
    assert.equal(formalRequests().length,0);
    await confirm(page);
    assert.equal(await page.evaluate(()=>location.href),recoveryTargets[i]);
    await page.close();
  }
  pass('浏览器重启后恢复多个检查页的完整网址，重新检查确认前零正式请求');
  assert.ok(await control.evaluate(async()=> (await chrome.storage.local.get('targetExitRecords')).targetExitRecords['claude.ai']?.[0]?.ip));
  const movedSettings=(await send({type:'GET_STATE'})).settings;
  assert.equal(movedSettings.accuracyM,45);assert.deepEqual(movedSettings.guardDefaults,savedDefaults);
  assert.equal((await control.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())).some(rule=>[9001,9002,9003,9004,9005,19000,19001].includes(rule.id)),false);
  assert.notEqual((await control.evaluate(()=>chrome.privacy.network.webRTCIPHandlingPolicy.get({}))).levelOfControl,'controlled_by_this_extension');
  const restored=await context.newPage();await verifyOrdinary(restored,'https://outside.test/after-upgrade');await restored.close();
  pass('升级清除旧全局语言规则和 WebRTC 策略；旧的全开设置保留时普通网站仍完全原生');
  const movedPage=await context.newPage();traffic.length=0;
  await openGate(movedPage,'https://claude.ai/relocated');
  assert.equal(await movedPage.locator('input[name="identityEnabled"][value="native"]').isChecked(),true);
  assert.equal(formalRequests().length,0);await confirm(movedPage);
  assert.equal((await movedPage.evaluate(()=>window.first)).zone,'America/Los_Angeles');
  assert.equal((await movedPage.evaluate(()=>window.first)).ua,original.ua);
  pass('换目录加载保持固定 ID、定位精度与默认选择；新目录的访问拦截和确认流程正常');
  await verifyOrdinary(movedPage,'https://outside.test/leave-anthropic');
  pass('同一标签页从 Anthropic 转到普通网站，主请求和页面都恢复原生语言、时区及设备');

  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/browser-guard.json', JSON.stringify({ browser: context.browser()?.version(), results, count: results.length }, null, 2));
  await openGate(movedPage, 'https://claude.ai/final');
  await movedPage.screenshot({ path: 'test-results/gate.png', fullPage: true });
  console.log(`Verified ${results.length} navigation scenarios.`);
} catch (error) {
  await mkdir('test-results', { recursive: true });
  const state = await context?.serviceWorkers()[0]?.evaluate(() => chrome.storage.session.get(null)).catch(() => null);
  await writeFile('test-results/browser-failure.json', JSON.stringify({ error: error.message, state, traffic,
    url: page?.url(), body: await page?.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally {
  await context?.close(); stun.close(); proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
  await rm(temporary, { recursive: true, force: true });
}
