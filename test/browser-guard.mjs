import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, access, rm, mkdir, writeFile } from 'node:fs/promises';
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
  if (url.pathname === '/cdn-cgi/trace') {
    response.setHeader('Content-Type', 'text/plain');
    response.end(policy.invalid ? 'challenge' : `h=${host.replace(/\.$/, '')}\nip=${policy.ip || '203.0.113.42'}\nloc=${policy.country || 'US'}\ncolo=LAX\n`);
  } else if (host === 'ipwho.is') {
    const jp = url.pathname.includes('203.0.113.43');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ip: jp ? '203.0.113.43' : '203.0.113.42', success: true, country_code: jp ? 'JP' : 'US',
      latitude: jp ? 35.68 : 34.05, longitude: jp ? 139.69 : -118.24, city: 'Test City',
      timezone: { id: jp ? 'Asia/Tokyo' : 'America/Los_Angeles' } }));
  } else if (host === 'reallyfreegeoip.org') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ip: '203.0.113.42', country_code: 'US', country_name: 'Test country', latitude: 34.05, longitude: -118.24 }));
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
      </script><script src="https://assets.claude.ai/asset.js"></script></head><body><h1 id="formal">FORMAL CONTENT</h1></body></html>`);
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
  await context.close();
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...options,args:[...options.args,`--disable-extensions-except=${resolve('.')}`,`--load-extension=${resolve('.')}`],
  });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension:'))
    || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith('chrome-extension:') });
  const id = new URL(worker.url()).hostname;
  control = await context.newPage(); await control.goto(`chrome-extension://${id}/popup.html`);
  await context.grantPermissions(['geolocation']);
  const original = await control.evaluate(() => ({ language: navigator.language, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, ua: navigator.userAgent }));
  const send = (message) => control.evaluate(message => chrome.runtime.sendMessage(message), message);
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Browser condition timed out');
  };
  const openGate = async (page, url) => {
    await page.goto(url).catch(error => { if (!/ERR_ABORTED|ERR_FAILED/.test(error.message)) throw error; });
    await wait(async () => page.url().startsWith(`chrome-extension://${id}/gate.html`));
    await page.getByRole('button', { name: '确认并访问', exact: true }).waitFor();
    await wait(async () => await page.locator('#retry').isEnabled());
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
  const workerProfile = page => page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js'); worker.onmessage = event => { resolve(event.data); worker.terminate(); }; worker.onerror = reject;
  }));
  const fontWidths = page => page.evaluate(async () => {
    const face = await new FontFace('Microsoft YaHei', 'url(https://assets.claude.ai/fixture.ttf)').load(); document.fonts.add(face);
    const context = document.createElement('canvas').getContext('2d');
    context.font = '30px "Microsoft YaHei", monospace'; const custom = context.measureText('Wiiii').width;
    context.font = '30px monospace'; return { custom, generic: context.measureText('Wiiii').width };
  });
  const pass = name => { results.push(name); console.log('PASS ' + name); };
  const formalRequests = () => traffic.filter(item => Network.protectedHost(`https://${item.host}/`) && item.path !== '/cdn-cgi/trace');

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
  await confirm(page);
  const first = await page.evaluate(() => window.first);
  assert.equal(first.language, 'en-US'); assert.equal(first.zone, 'America/Los_Angeles'); assert.equal(first.hash, '#original');
  assert.ok(!first.ua.includes('HeadlessChrome'));
  assert.equal(formalRequests().find(item => item.path === '/page').language, 'en-US,en;q=0.9');
  assert.ok(await page.evaluate(() => window.assetLoaded));
  pass('点击确认后才加载网站；第一个内联脚本已获得正确时区、语言与标识，HTTP 头同步');

  traffic.length = 0;
  await page.reload();
  await wait(async () => page.url().startsWith(`chrome-extension://${id}/gate.html`) && await page.locator('#retry').isEnabled());
  assert.equal(formalRequests().length, 0); await confirm(page);
  pass('同一标签页刷新也重新检查、重新确认，旧放行不能复用');

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
  pass('未知出口不能手动绕过检查');

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
  await another.getByRole('button', { name: '确认并访问', exact: true }).click();
  await another.locator('#error').getByText('出口或连接状态已变化，请重新检查并确认').waitFor();
  assert.equal(formalRequests().length, 0);
  pass('检查后、确认前出口改变时拒绝放行');

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
    ['Web Worker', async page => assert.deepEqual(await workerProfile(page), nativeWorker)],
    ['WebRTC', async () => assert.notEqual((await control.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}))).levelOfControl, 'controlled_by_this_extension')],
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
  await select(another, 'Web Worker', '伪装'); await confirm(another);
  await workerProfile(another); await another.waitForTimeout(200);
  assert.deepEqual(await workerProfile(another), { zone:'America/Los_Angeles',language:'en-US' });
  const hiddenFont = await fontWidths(another); assert.equal(hiddenFont.custom, hiddenFont.generic);
  pass('主动开启 Worker 伪装后使用所选时区语言；字体伪装能隐藏已加载的地区字体');

  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/browser-guard.json', JSON.stringify({ browser: context.browser()?.version(), results, count: results.length }, null, 2));
  await openGate(another, 'https://claude.ai/final');
  await another.screenshot({ path: 'test-results/gate.png', fullPage: true });
  console.log(`Verified ${results.length} navigation scenarios.`);
} catch (error) {
  await mkdir('test-results', { recursive: true });
  const state = await context?.serviceWorkers()[0]?.evaluate(() => chrome.storage.session.get(null)).catch(() => null);
  await writeFile('test-results/browser-failure.json', JSON.stringify({ error: error.message, state, traffic,
    url: page?.url(), body: await page?.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally {
  await context?.close(); proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
  await rm(temporary, { recursive: true, force: true });
}
