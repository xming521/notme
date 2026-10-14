'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Network = require('../lib/network.js');
const Environment = require('../lib/environment.js');
const Providers = require('../lib/providers.js');
const UDP = require('../lib/udp.js');
const trace = (country = 'US', ip = '203.0.113.42') => ({ ip, country, colo: 'LAX' });
const probe = (country = 'US') => ({ reachable: true, status: 200, durationMs: 30, trace: trace(country) });

test('主域及新子域受保护，仿冒域名不匹配', () => {
  for (const root of Network.ROOT_DOMAINS) {
    assert.equal(Network.protectedHost(`https://a.b.${root}/`), `a.b.${root}`);
    assert.equal(Network.protectedHost(`https://${root}.evil.test/`), null);
    assert.equal(Network.protectedHost(`https://evil${root}/`), null);
  }
});
test('任何受限地区、未知或变化的出口不能自动通过', () => {
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe(), probe()]).status, 'ok');
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe('HK'), probe()]).status, 'fail');
  assert.equal(Network.assessProbes('claude.ai', [probe(), { ...probe(), trace: null }, probe()]).status, 'warn');
  assert.equal(Network.assessProbes('claude.ai', [probe(), probe('JP'), probe()]).status, 'warn');
});
test('自动伪装需要可靠出口位置，手动环境沿用原流程，系统默认无需伪装数据', () => {
  const report = { status: 'ok', trace: trace() };
  const location = { ip: '203.0.113.42', countryCode: 'US', timezone: 'America/Los_Angeles' };
  const selected = Environment.defaultSelection({});
  const checked = Environment.checks(report, location, {}, selected);
  assert.equal(Environment.ready(report, checked), true);
  for (const changes of [{ ip: '203.0.113.99' }, { countryCode: 'JP' }, { timezone: 'Not/AZone' }]) {
    assert.equal(Environment.ready(report, Environment.checks(report, { ...location, ...changes }, {}, selected)), false);
  }
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

test('UDP 只采信 UDP server-reflexive 响应，不把本地候选或 TCP 当作 UDP 成功', () => {
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 udp 1 host.local 1234 typ host'}),null);
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 tcp 1 203.0.113.42 1234 typ srflx'}),null);
  assert.equal(UDP.candidateIP({candidate:'candidate:1 1 udp 1 203.0.113.42 1234 typ srflx'}),'203.0.113.42');
  assert.equal(UDP.assess({state:'available',ips:['203.0.113.42']},'203.0.113.42').status,'ok');
  assert.equal(UDP.assess({state:'available',ips:['203.0.113.43']},'203.0.113.42').status,'warn');
  assert.equal(UDP.assess({state:'available',ips:['2001:db8::1']},'2001:0db8:0:0:0:0:0:1').status,'ok');
  assert.equal(UDP.assess({state:'unknown',ips:[]},'203.0.113.42').status,'info');
  assert.equal(UDP.assess({state:'available',ips:['not-an-ip']},'203.0.113.42').status,'info');
});

test('已开启非代理 UDP 保护时不创建 PeerConnection、不发送 STUN', async () => {
  let calls=0;
  const result=await UDP.probe({policy:'disable_non_proxied_udp',PeerConnection:class {constructor(){calls++;}}});
  assert.equal(calls,0);assert.equal(result.state,'restricted');
  assert.equal(UDP.assess(result,'203.0.113.42').status,'info');
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
