'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Identity = require('../lib/identity.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

function page(host, ua, platform, device, origin) {
  const ctx = vm.createContext({ host, ua, platform, device, origin });
  vm.runInContext(`
    const nativeBrands = [{ brand: 'Chromium', version: '140' }, { brand: 'QQ Browser', version: '20' }];
    class NavigatorUAData {
      get brands() { if (!(this instanceof NavigatorUAData)) throw new TypeError(); return nativeBrands; }
      get mobile() { if (!(this instanceof NavigatorUAData)) throw new TypeError(); return /Android/.test(ua); }
      get platform() { if (!(this instanceof NavigatorUAData)) throw new TypeError(); return platform; }
      getHighEntropyValues(hints) {
        if (!(this instanceof NavigatorUAData)) throw new TypeError();
        if (!Array.isArray(hints)) return Promise.reject(new TypeError());
        const result = this.toJSON();
        for (const hint of hints) {
          if (hint === 'model') result.model = device;
          if (hint === 'uaFullVersion') result.uaFullVersion = '140.0.1234.10';
          if (hint === 'fullVersionList') result.fullVersionList = [{ brand: 'QQ Browser', version: '20.0' }];
          if (hint === 'architecture') result.architecture = 'arm';
          if (hint === 'platformVersion') result.platformVersion = '14.0.0';
        }
        return Promise.resolve(result);
      }
      toJSON() {
        if (!(this instanceof NavigatorUAData)) throw new TypeError();
        return { brands: this.brands, mobile: this.mobile, platform: this.platform };
      }
    }
    const nativeData = new NavigatorUAData();
    class Navigator {
      get userAgent() { if (!(this instanceof Navigator)) throw new TypeError(); return ua; }
      get appVersion() { if (!(this instanceof Navigator)) throw new TypeError(); return ua.replace('Mozilla/', ''); }
      get platform() { if (!(this instanceof Navigator)) throw new TypeError(); return platform; }
      get vendor() { if (!(this instanceof Navigator)) throw new TypeError(); return 'Chinese vendor'; }
      get userAgentData() { if (!(this instanceof Navigator)) throw new TypeError(); return nativeData; }
      get language() { return 'zh-CN'; }
      get languages() { return ['zh-CN']; }
    }
    globalThis.navigator = new Navigator();
    globalThis.window = globalThis; globalThis.self = globalThis;
    globalThis.origin = origin || 'https://' + host;
    globalThis.location = { hostname: host };
    globalThis.URL = class URL { constructor(value) { this.hostname = /^https?:\\/\\/([^/:]+)/.exec(value)[1]; } };
    const messages = [];
    globalThis.addEventListener = (type, fn) => { if (type === 'message') messages.push(fn); };
    globalThis.postMessage = () => {}; globalThis.setTimeout = () => 0;
    globalThis.publish = payload => messages.forEach(fn => fn({ data: { __nmb__: 'data', payload } }));
    globalThis.nativeData = nativeData;
  `, ctx);
  for (const file of ['lib/timezone.js', 'lib/identity.js', 'content-inject.js']) vm.runInContext(read(file), ctx);
  return ctx;
}
function snapshot(ctx) {
  return plain(vm.runInContext(`({
    ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform,
    vendor: navigator.vendor, low: navigator.userAgentData.toJSON(),
    sameObject: navigator.userAgentData === nativeData,
    frozen: Object.isFrozen(navigator.userAgentData.brands), helperVisible: 'NotmeIdentity' in window,
  })`, ctx));
}
async function main() {
  await test('profiles remove vendor identifiers while preserving Chromium version and OS family', () => {
    for (const [ua, platform, expected] of [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 QQBrowser/20 HuaweiBrowser/1', 'Win32', 'Windows'],
      ['Mozilla/5.0 (Linux; Android 14; HUAWEI) Chrome/140.0.0.0 Mobile MicroMessenger/8', 'Linux armv8l', 'Android'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Maxthon/8', 'MacIntel', 'macOS'],
    ]) {
      const p = Identity.buildProfile(ua, platform);
      assert(!/QQBrowser|Huawei|MicroMessenger|Maxthon/i.test(p.userAgent));
      assert.equal(p.version, '140.0.0.0'); assert.equal(p.uaPlatform, expected);
    }
  });
  await test('admitted identity preserves native objects and validation', async () => {
    const ctx = page('claude.ai', 'Mozilla/5.0 (Linux; Android 14; HUAWEI) Chrome/140.0.0.0 Mobile QQBrowser/20', 'Android', 'HUAWEI P60');
    vm.runInContext('publish({guardSelection:true,identityEnabled:true})', ctx);
    const s = snapshot(ctx);
    assert(!/QQBrowser|Huawei/i.test(s.ua));
    assert.equal(s.low.platform, 'Android'); assert.equal(s.low.mobile, true);
    assert.deepEqual(s.low.brands.map(b => b.brand), ['Chromium', 'Google Chrome']);
    assert(s.sameObject && s.frozen && !s.helperVisible);
    const high = plain(await vm.runInContext("navigator.userAgentData.getHighEntropyValues(['model','uaFullVersion','fullVersionList','architecture','platformVersion'])", ctx));
    assert.equal(high.model, ''); assert.equal(high.uaFullVersion, '140.0.0.0');
    assert.equal(high.architecture, 'arm'); assert.equal(high.platformVersion, '14.0.0');
    assert.deepEqual(high.fullVersionList.map(b => b.brand), ['Chromium', 'Google Chrome']);
    const limited = plain(await vm.runInContext('navigator.userAgentData.getHighEntropyValues([])', ctx));
    assert(!('model' in limited) && !('uaFullVersion' in limited));
    await assert.rejects(vm.runInContext('navigator.userAgentData.getHighEntropyValues(null)', ctx));
    assert.throws(() => vm.runInContext('navigator.userAgentData.toJSON.call({})', ctx));
    assert.throws(() => vm.runInContext("Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'userAgent').get.call({})", ctx));
    assert.equal(vm.runInContext('Function.prototype.toString.call(navigator.userAgentData.getHighEntropyValues)', ctx), 'function getHighEntropyValues() { [native code] }');
  });
  await test('unrelated, unlisted verification and lookalike domains stay native even with legacy global toggles', async () => {
    for (const host of ['outside.test', 'claude.ai.outside.test', 'fakeanthropic.com', 'fuck-claude.app.evil.test', 'www.fuck-claude.vercel.app', 'other.vercel.app']) {
      const ctx = page(host, 'Chrome/140.0.0.0 QQBrowser/20', 'Win32', 'HUAWEI P60');
      vm.runInContext('publish({identityEnabled:true,langEnabled:true,tzEnabled:true})', ctx);
      assert(snapshot(ctx).ua.includes('QQBrowser'),host);
      assert.equal((await vm.runInContext("navigator.userAgentData.getHighEntropyValues(['model'])", ctx)).model,'HUAWEI P60');
      assert.equal(vm.runInContext('navigator.language',ctx),'zh-CN');
    }
    for (const host of ['claude.ai','api.anthropic.com','claude.com','brandnew.claude.site','fuck-claude.app','fuck-claude.vercel.app','']) {
      const ctx = page(host,'Chrome/140.0.0.0 QQBrowser/20','Win32','HUAWEI P60','https://claude.ai');
      vm.runInContext('publish({guardSelection:true,identityEnabled:false})',ctx);
      assert(snapshot(ctx).ua.includes('QQBrowser'));
      vm.runInContext('publish({guardSelection:true,identityEnabled:true})',ctx);
      assert(!snapshot(ctx).ua.includes('QQBrowser'));
    }
  });
  await test('bridge profile keeps JS and outgoing headers on the same identity', async () => {
    const p = Identity.buildProfile('Chrome/141.0.0.0 Edg/141.0.0.0', 'Win32');
    const ctx = page('claude.ai', 'Chrome/140.0.0.0 QQBrowser/20', 'Win32', 'HUAWEI P60');
    ctx.payload = { guardSelection: true, identityEnabled: true, identityProfile: p };
    vm.runInContext('publish(payload)', ctx);
    assert.equal(snapshot(ctx).ua, p.userAgent);
    const high = plain(await vm.runInContext("navigator.userAgentData.getHighEntropyValues(['model','fullVersionList','uaFullVersion'])", ctx));
    const headers = Object.fromEntries(Identity.requestHeaders(p).map(h => [h.header, h.value]));
    assert.equal(headers['user-agent'], snapshot(ctx).ua);
    assert.equal(headers['sec-ch-ua-model'], JSON.stringify(high.model));
    assert.equal(headers['sec-ch-ua-full-version'], JSON.stringify(high.uaFullVersion));
    assert.equal(headers['sec-ch-ua-platform'], JSON.stringify(snapshot(ctx).low.platform));
  });
  await test('upgrade removes legacy global rules and privacy control without deleting other rules', async () => {
    const stored={},listener={addListener(){}};
    const rules=new Map([9001,9002,9003,9004,9005,19000,19001,501].map(id=>[id,{id}]));
    const session={guardWebRTCProtect:true};let controlled=true;
    const ctx=vm.createContext({
      navigator:{userAgent:'Chrome/140.0.0.0 QQBrowser/20',platform:'Win32'},importScripts(){},
      chrome:{
        storage:{local:{async get(){return plain(stored);},async set(value){Object.assign(stored,plain(value));}},session:{async remove(key){delete session[key];}}},
        declarativeNetRequest:{async updateDynamicRules(value){for(const id of value.removeRuleIds)rules.delete(id);for(const rule of value.addRules)rules.set(rule.id,rule);}},
        privacy:{network:{webRTCIPHandlingPolicy:{async clear(){controlled=false;}}}},
        runtime:{onInstalled:listener,onStartup:listener,onMessage:listener},alarms:{onAlarm:listener},action:{onClicked:listener},
      },
    });
    ctx.self=ctx;
    for(const file of ['lib/network.js','lib/environment.js','lib/identity.js','background.js'])vm.runInContext(read(file),ctx);
    await vm.runInContext('legacyCleanup',ctx);
    assert.deepEqual([...rules.keys()],[501]);assert.equal(controlled,false);
    assert.equal(session.guardWebRTCProtect,undefined);
    assert(!stored.identityProfile.userAgent.includes('QQBrowser'));
  });
  console.log('\n' + passed + ' identity tests passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
