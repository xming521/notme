'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Network = require('../lib/network.js');
const Environment = require('../lib/environment.js');
const Providers = require('../lib/providers.js');
const UDP = require('../lib/udp.js');
const trace = (country = 'US', ip = '203.0.113.42') => ({ ip, country, colo: 'LAX' });
const probe = (country = 'US') => ({ reachable: true, status: 200, durationMs: 30, trace: trace(country) });

test('默认不提供位置，明确选择后才允许位置伪装或系统定位', () => {
  for (const guardDefaults of [undefined, {enabled:true}, {enabled:false}]) {
    const selected=Environment.defaultSelection({guardDefaults});
    assert.equal(selected.geoMode,'blocked');assert.equal(selected.enabled,false);
  }
  assert.equal(Environment.normalizeSelection({geoMode:'spoof'},{}).enabled,true);
  assert.equal(Environment.normalizeSelection({geoMode:'native'},{}).enabled,false);
  assert.equal(Environment.defaultSelection({guardDefaults:{geoMode:'native'}}).geoMode,'native');
});

test('地区服务并行查询并收集较晚返回的限制地区，不因先返回正常地区而跳过拦截', async () => {
  const native=global.fetch;let active=0,peak=0;const observations=[];
  global.fetch=async url=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,url.includes('ipinfo')?35:10));active--;
    const country=url.includes('ipinfo')?'HK':'US';
    return new Response(JSON.stringify({ip:'203.0.113.42',success:true,country_code:country,country,
      latitude:34,longitude:-118,loc:'34,-118',timezone:'America/Los_Angeles'}));
  };
  try {
    const observe=item=>observations.push({...item,source:item.provider});
    assert.equal((await Providers.getCountryForIP('203.0.113.42','',observe)).countryCode,'US');
    assert.equal(peak,3);
    assert.equal(Network.applyExitPolicy(Network.assessProbes('claude.ai',[probe(),probe(),probe()]),observations).regionBlocked,true);
    peak=0;observations.length=0;
    await Providers.getIPLocation('',observe);
    assert.equal(peak,4);
    assert.ok(observations.some(item=>item.countryCode==='HK'));
  } finally {global.fetch=native;}
});

test('地区查询的超时包含响应正文，服务不结束 JSON 时仍按时终止', {timeout:1000}, async () => {
  const native=global.fetch;const signals=[];
  global.fetch=async (_url,{signal})=>{
    signals.push(signal);
    return {ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))};
  };
  try {
    assert.equal(await Providers.getCountryForIP('203.0.113.42','',undefined,{timeoutMs:35}),null);
    assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal.aborted));
  } finally {global.fetch=native;}
});

test('主域及新子域受保护，仿冒域名不匹配', () => {
  for (const root of Network.ROOT_DOMAINS) {
    assert.equal(Network.protectedHost(`https://a.b.${root}/`), `a.b.${root}`);
    assert.equal(Network.protectedHost(`https://${root}.evil.test/`), null);
    assert.equal(Network.protectedHost(`https://evil${root}/`), null);
  }
});
test('两个检测站进入访问闸门，仅匹配指定域名，不扩大到子域或整个 Vercel 平台', () => {
  for (const host of Network.VERIFICATION_DOMAINS) {
    assert.equal(Network.verificationHost(`https://${host}/scan`), host);
    assert.equal(Network.verificationHost(`https://${host.toUpperCase()}./`), host);
    assert.equal(Network.protectedHost(`https://${host}/`), host);
    for (const value of [`https://sub.${host}/`, `https://${host}.evil.test/`, `ftp://${host}/`]) {
      assert.equal(Network.verificationHost(value), null);
      assert.equal(Network.protectedHost(value), null);
    }
  }
  assert.equal(Network.verificationHost('https://other.vercel.app/'), null);
});
test('地区限制只拦截中国大陆和香港，出口不同或地区未知不作为地区封禁', () => {
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe(), probe()]).status, 'ok');
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe('HK'), probe()]).status, 'fail');
  assert.equal(Network.assessProbes('claude.ai', [probe(), { ...probe(), trace: null }, probe()]).status, 'ok');
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe('JP'), probe()]).status, 'ok');
  for (const country of ['CN', 'HK']) assert.equal(Network.assessProbes('claude.ai', [probe(), probe(country), probe()]).status, 'fail');
  for (const country of ['KP', 'CU', 'IR', 'SY', 'RU', 'BY', 'MO', 'TW']) {
    assert.equal(Network.assessProbes('claude.ai', [probe(country), probe(country), probe(country)]).status, 'ok');
  }
});
test('自动伪装需要可靠出口位置，手动环境沿用原流程，系统默认无需伪装数据', () => {
  const report = { status: 'ok', trace: trace() };
  const location = { ip: '203.0.113.42', countryCode: 'US', timezone: 'America/Los_Angeles' };
  const selected = Environment.defaultSelection({});
  const checked = Environment.checks(report, location, {}, selected);
  assert.equal(Environment.ready(report, checked), true);
  for (const changes of [{ ip: '203.0.113.99' }, { timezone: 'Not/AZone' }]) {
    assert.equal(Environment.ready(report, Environment.checks(report, { ...location, ...changes }, {}, selected)), false);
  }
  assert.equal(Environment.ready(report, Environment.checks(report, { ...location, countryCode: 'JP' }, {}, selected)), true);
  assert.equal(Environment.ready(report, Environment.checks(report, location, { manualTz: 'Asia/Tokyo' }, selected)), true);
  const original = Object.fromEntries(Environment.SURFACES.map(({ key }) => [key, false]));
  assert.equal(Environment.ready(report, Environment.checks(report, null, {}, original)), true);
  assert.equal(Environment.ready({ status: 'fail' }, []), false);
});
test('查地理位置时使用服务观察到的IP，不能改查普通查IP服务的出口', async () => {
  const native = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ip: '203.0.113.42', success: true, country_code: 'US',
      latitude: 34.05, longitude: -118.24, timezone: { id: 'America/Los_Angeles' } }));
  };
  try {
    const result = await Providers.getLocationForIP('203.0.113.42');
    assert.equal(result.ip, '203.0.113.42');
    assert.equal(result.timezone, 'America/Los_Angeles');
    assert.equal(calls[0].url, 'https://ipwho.is/203.0.113.42');
    assert.equal(calls[0].options.credentials, 'omit');
  } finally { global.fetch = native; }
});

test('HTTP/3 必须在目标 trace 中实际出现，HTTP/2 回退和未知协议不冒充 HTTP/3', () => {
  const parse = protocol => Network.parseTrace(`h=claude.ai\nip=203.0.113.42\nloc=US\n${protocol ? 'http='+protocol : ''}`, 'claude.ai');
  for (const [protocol, expected] of [['http/3','ok'],['http/2','info'],['http/1.1','info'],['','info'],['garbage','info']]) {
    const report = Network.assessProbes('claude.ai', Array.from({length:3}, () => ({...probe(),trace:parse(protocol)})));
    assert.equal(report.checks.find(check => check.name === 'HTTP/3 / QUIC').status, expected);
    assert.equal(report.status,'ok');
  }
  const blocked = Network.assessProbes('claude.ai', [{...probe('HK'),trace:{...trace('HK'),protocol:'http/3'}},probe(),probe()]);
  assert.equal(blocked.status,'fail');
});

test('出口一项按 TCP 和 HTTP/3 分别显示真实出口，并比较一致性', () => {
  const sample = (protocol, ip = '203.0.113.42', country = 'US', colo = 'LAX') => ({
    ...probe(), trace: { ip, country, colo, protocol },
  });
  const matched = Network.assessProbes('claude.ai', [sample('http/2'), sample('http/3'), sample('http/3', '203.0.113.42', 'US', 'SJC')]);
  const matchedExit = matched.checks.find(check => check.name === '出口 IP / 地区');
  assert.match(matchedExit.detail, /TCP：203\.0\.113\.42 · US · LAX/);
  assert.match(matchedExit.detail, /HTTP\/3：203\.0\.113\.42 · US · SJC/);
  assert.match(matchedExit.detail, /TCP \/ HTTP\/3 出口一致/);
  assert.equal(matchedExit.status, 'ok');
  assert.equal(matched.status, 'ok');

  for (const [ip, country] of [['203.0.113.99', 'US'], ['203.0.113.42', 'JP']]) {
    const different = Network.assessProbes('claude.ai', [sample('http/2'), sample('http/3', ip, country), sample('http/2')]);
    const differentExit = different.checks.find(check => check.name === '出口 IP / 地区');
    assert.ok(differentExit.detail.includes(`HTTP/3：${ip} · ${country}`));
    assert.match(differentExit.detail, /TCP \/ HTTP\/3 出口不同，可能由分流产生，不代表异常/);
    assert.equal(differentExit.status, 'info');
    assert.equal(different.status, 'ok');
  }
});

test('缺少任一协议的实测出口时显示未验证，不能把单协议或未知协议当作出口一致', () => {
  for (const protocol of ['http/2', 'http/1.1', 'http/3', null]) {
    const report = Network.assessProbes('claude.ai', Array.from({ length: 3 }, () => ({
      ...probe(), trace: { ...trace(), protocol },
    })));
    const exit = report.checks.find(check => check.name === '出口 IP / 地区');
    assert.match(exit.detail, /TCP \/ HTTP\/3 出口一致性未验证/);
    assert.equal(exit.status, 'info');
    assert.equal(report.status, 'ok');
    if (protocol === 'http/3') assert.match(exit.detail, /TCP：未验证/);
    else assert.match(exit.detail, /HTTP\/3：未验证/);
    if (!protocol) assert.match(exit.detail, /协议未知：203\.0\.113\.42 · US · LAX/);
  }
});

test('第三方 QUIC 探测先预热，再采信测试站实际 HTTP/3 响应，请求不携带凭据', async () => {
  const calls = [];
  const result = await Network.probeThirdPartyHTTP3(Network.DEFAULT_SETTINGS, async (url, options) => {
    calls.push({ url, options });
    return new Response(`h=${Network.HTTP3_TEST_HOST}\nip=203.0.113.42\nloc=US\ncolo=LAX\nhttp=${calls.length === 1 ? 'http/2' : 'http/3'}\n`,
      { headers: { 'Alt-Svc': 'h3=":443"' } });
  });
  assert.equal(calls.length, 2);
  assert.equal(result.trace.protocol, 'http/3');
  for (const { url, options } of calls) {
    assert.equal(new URL(url).hostname, Network.HTTP3_TEST_HOST);
    assert.equal(new URL(url).pathname, '/cdn-cgi/trace');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'manual');
  }
});

test('第三方的 HTTP/2、错误主机、无效响应及超时都不能冒充 HTTP/3 出口', async () => {
  const target = Network.assessProbes('claude.ai', [probe(), probe(), probe()]);
  for (const body of [`h=${Network.HTTP3_TEST_HOST}\nip=203.0.113.42\nloc=US\nhttp=http/2`,
    'h=other.test\nip=203.0.113.42\nloc=US\nhttp=http/3', 'challenge']) {
    let calls = 0;
    const result = await Network.probeThirdPartyHTTP3(Network.DEFAULT_SETTINGS, async () => {
      calls++; return new Response(body, { headers: { 'Alt-Svc': 'h3=":443"' } });
    });
    assert.equal(calls, 3);
    const check = Network.withThirdPartyHTTP3(target, result).checks.find(check => check.name.includes('第三方参考'));
    assert.equal(check.status, 'info');
    assert.match(check.detail, /HTTP\/3 出口未验证/);
    if(body.includes('http=http/2')){assert.match(check.detail,/测试站出口：203\.0\.113\.42/);assert.match(check.detail,/实际协议：HTTP\/2/);}
    assert.doesNotMatch(check.detail, /与目标 HTTPS 出口一致/);
  }
  const timeout = await Network.probeThirdPartyHTTP3({ ...Network.DEFAULT_SETTINGS, timeoutMs: 5 },
    async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  assert.equal(timeout.trace, null);
  assert.equal(timeout.error, '探测超时');
});

test('第三方 HTTP/3 比较标清来源，保留目标出口和访问判定，差异只作诊断提示', () => {
  const target = Network.assessProbes('claude.ai', Array.from({ length: 3 }, () => ({ ...probe(), trace: { ...trace(), protocol: 'http/2' } })));
  for (const [ip, country, status] of [['203.0.113.42', 'US', 'ok'], ['203.0.113.99', 'US', 'info'], ['203.0.113.42', 'JP', 'info']]) {
    const result = { host: Network.HTTP3_TEST_HOST, trace: { ...trace(country, ip), protocol: 'http/3' } };
    const report = Network.withThirdPartyHTTP3(target, result);
    const exit = report.checks.find(check => check.name === '出口 IP / 地区');
    const diagnostic = report.checks.find(check => check.name.includes('第三方参考'));
    assert.deepEqual(exit,target.checks.find(check => check.name === '出口 IP / 地区'));
    assert.equal(diagnostic.status,status);
    assert.equal(report.trace, target.trace);
    assert.equal(report.status, 'ok');

    assert.ok(diagnostic.detail.includes(`HTTP/3 出口：${ip} · ${country}`));
    assert.match(diagnostic.detail, /第三方参考，仅代表到测试站的出口，不代表 Anthropic/);
    assert.match(diagnostic.detail, status === 'ok' ? /与目标 HTTPS 出口一致/ : /与目标 HTTPS 出口不同，可能由分流产生，不代表异常/);
  }
  const restricted = Network.assessProbes('claude.ai', [probe('HK'), probe('HK'), probe('HK')]);
  const report = Network.withThirdPartyHTTP3(restricted, { host: Network.HTTP3_TEST_HOST, trace: { ...trace(), protocol: 'http/3' } });
  assert.equal(report.status, 'fail');
  assert.equal(report.trace.country, 'HK');
  assert.equal(report.checks.find(check => check.name === '出口 IP / 地区').status, 'fail');
  assert.match(report.checks.find(check => check.name === '出口 IP / 地区').detail, /命中中国大陆 \/ 香港地区拦截规则/);
  const ipv6 = Network.assessProbes('claude.ai', Array.from({ length: 3 }, () => ({ ...probe(), trace: trace('US', '2001:0db8::1') })));
  assert.equal(Network.withThirdPartyHTTP3(ipv6, { trace: { ...trace('US', '2001:db8::1'), protocol: 'http/3' } })
    .checks.find(check => check.name.includes('第三方参考')).status, 'ok');
});

test('任意来源的任何一个大陆或香港 IPv4/IPv6 都拦截，后续正常结果不能覆盖已发现的限制地区', () => {
  const target = Network.assessProbes('claude.ai', [probe(), probe(), probe()]);
  for (const source of ['目标站', '第三方 HTTP/3', '第三方 UDP / STUN', '第三方查 IP 服务', 'IP 地理查询']) {
    for (const [ip, countryCode] of [['203.0.113.99', 'cn'], ['2001:db8::99', 'HK']]) {
      const blocked = Network.applyExitPolicy(target, [{ ip, countryCode, source }]);
      assert.equal(blocked.regionBlocked, true);
      assert.equal(blocked.status, 'fail');
      assert.equal(blocked.ready, false);
      assert.equal(Environment.ready(blocked, []), false);
      assert.ok(blocked.checks.find(check => check.name === '出口地区检查').detail.includes(source));
      assert.equal(Network.applyExitPolicy(blocked, [{ ip: '203.0.113.42', country: 'US', source }]).status, 'fail');
    }
  }
  assert.equal(Network.applyExitPolicy(target, [{ ip: 'not-an-ip', country: 'CN', source: '无效响应' }]).regionBlocked, false);
  const unknown = Network.applyExitPolicy(target, [{ ip: '203.0.113.99', source: '地区查询失败' }]);
  assert.equal(unknown.regionBlocked, false);
  assert.equal(unknown.status, 'ok');
  assert.match(unknown.checks.find(check => check.name === '出口地区检查').detail, /地区未确认/);
});

test('第三方 HTTP/2 回退返回大陆出口也必须拦截，不依赖 HTTP/3 是否验证成功', async () => {
  const target = Network.assessProbes('claude.ai', [probe(), probe(), probe()]);
  let calls = 0;
  const result = await Network.probeThirdPartyHTTP3(Network.DEFAULT_SETTINGS, async () => {
    calls++; return new Response(`h=${Network.HTTP3_TEST_HOST}\nip=203.0.113.99\nloc=CN\nhttp=http/2`);
  });
  assert.equal(calls, 1);
  assert.equal(result.trace.protocol, 'http/2');
  const checked = Network.withThirdPartyHTTP3(target, result);
  assert.equal(checked.regionBlocked, true);
  assert.equal(checked.status, 'fail');
  assert.equal(checked.checks.find(check => check.name.includes('第三方参考')).status, 'fail');
  assert.match(checked.checks.find(check => check.name.includes('第三方参考')).detail, /HTTP\/3 出口未验证/);
});

test('STUN 地区查询无需坐标时区，多个 UDP 出口中任一香港或大陆 IP 都禁止访问', async () => {
  const native = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ success: true, ip: '2001:db8::99', country_code: 'HK' }));
  try {
    const location = await Providers.getCountryForIP('2001:0db8::99');
    assert.equal(location.countryCode, 'HK');
    assert.equal(location.timezone, null);
    const result = { state: 'available', ips: ['203.0.113.42', '2001:db8::99'],
      regions: [{ ip: '203.0.113.42', countryCode: 'US' }, { ip: location.ip, countryCode: location.countryCode }] };
    const checked = UDP.assess(result, '203.0.113.42');
    assert.equal(checked.status, 'fail');
    assert.equal(checked.blocking, true);
    assert.match(checked.detail, /禁止访问/);
    assert.match(checked.detail, /不代表 Anthropic/);
  } finally { global.fetch = native; }
});

test('地理服务的早期大陆结果不能被后续有效环境覆盖，查 IP 服务同样记录每个返回的 IP', async () => {
  const native = global.fetch;
  const observed = [];
  global.fetch = async url => {
    const partial = url.startsWith('https://ipwho.is/') || url.startsWith('https://reallyfreegeoip.org/');
    return new Response(JSON.stringify({ ip: '203.0.113.42', success: true, country_code: partial ? 'CN' : 'US',
      ...(partial ? {} : { latitude: 34, longitude: -118, timezone: 'America/Los_Angeles' }) }));
  };
  try {
    const location = await Providers.getLocationForIP('203.0.113.42', '', item => observed.push({ ...item, source: item.provider }));
    assert.equal(location.countryCode, 'US');
    assert.equal(Network.applyExitPolicy(Network.assessProbes('claude.ai', [probe(), probe(), probe()]), observed).status, 'fail');
    observed.length = 0;
    await Providers.getIPLocation('', item => observed.push({ ...item, source: item.provider }));
    assert.ok(observed.some(item => item.provider === 'reallyfreegeoip' && item.countryCode === 'CN'));
    assert.equal(Network.applyExitPolicy(Network.assessProbes('claude.ai', [probe(), probe(), probe()]), observed).regionBlocked, true);
  } finally { global.fetch = native; }
});

test('UDP 只采信 UDP server-reflexive 响应，不把本地候选或 TCP 当作 UDP 成功', () => {
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 udp 1 host.local 1234 typ host'}),null);
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 tcp 1 203.0.113.42 1234 typ srflx'}),null);
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 udp 1 203.0.113.42 1234 typ srflx'}),'203.0.113.42');
  assert.equal(UDP.assess({state:'available',ips:['203.0.113.42']},'203.0.113.42').status,'ok');
  assert.equal(UDP.assess({state:'available',ips:['203.0.113.43']},'203.0.113.42').status,'info');
  assert.equal(UDP.assess({state:'available',ips:['2001:db8::1']},'2001:0db8:0:0:0:0:0:1').status,'ok');
  assert.equal(UDP.assess({state:'unknown',ips:[]},'203.0.113.42').status,'info');
  assert.equal(UDP.assess({state:'available',ips:['not-an-ip']},'203.0.113.42').status,'info');
});

test('实际启用非代理 UDP 保护时显示防护通过，不创建 PeerConnection、不发送 STUN', async () => {
  let calls=0;
  const result=await UDP.probe({policy:'disable_non_proxied_udp',PeerConnection:class {constructor(){calls++;}}});
  assert.equal(calls,0);assert.equal(result.state,'restricted');
  const checked = UDP.assess(result,'203.0.113.42');
  assert.equal(checked.status,'ok');
  assert.match(checked.detail,/WebRTC 防泄漏保护已生效/);
  assert.match(checked.detail,/未发送 STUN/);
  assert.doesNotMatch(checked.detail,/出口一致/);
  assert.equal(UDP.assess({state:'restricted',policy:'default'},'203.0.113.42').status,'info');
  assert.equal(UDP.assess({state:'restricted'},'203.0.113.42').status,'info');
});

test('UDP 探测收集响应后关闭连接，超时与异常不会误报成功', async () => {
  let closed=0;
  class Peer {
    createDataChannel(){}
    async createOffer(){return {};}
    async setLocalDescription(){setTimeout(()=>{
      this.onicecandidate?.({candidate:{protocol:'udp',type:'srflx',address:'203.0.113.42'}});
      this.onicecandidate?.({candidate:null});
    },0);}
    close(){closed++;}
  }
  const result=await UDP.probe({PeerConnection:Peer,timeoutMs:100});
  assert.equal(result.state,'available');assert.deepEqual(result.ips,['203.0.113.42']);assert.equal(closed,1);
  class Silent extends Peer {async setLocalDescription(){}}
  assert.equal((await UDP.probe({PeerConnection:Silent,timeoutMs:5})).state,'unknown');
  assert.equal((await UDP.probe({PeerConnection:class {constructor(){throw new Error('unavailable');}}})).state,'unknown');
});
