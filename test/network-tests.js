'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Network = require('../lib/network.js');
const Environment = require('../lib/environment.js');
const Providers = require('../lib/providers.js');
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
