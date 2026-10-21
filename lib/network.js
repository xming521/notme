/* notme — target-domain network preflight. */
(function () {
'use strict';
const root = typeof self !== 'undefined' ? self : globalThis;
const ROOT_DOMAINS = [
  "anthropic.com", "claude.ai", "claude.com", "claude.app",
  "claudeusercontent.com", "claudemcpcontent.com", "claude.site",
];
const VERIFICATION_DOMAINS = ['fuck-claude.vercel.app', 'fuck-claude.app'];

function verificationHost(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return ['http:', 'https:', 'wss:'].includes(url.protocol) && VERIFICATION_DOMAINS.includes(host) ? host : null;
  } catch (_) { return null; }
}

const DEFAULT_SETTINGS = {
  blockedCountries: ["CN", "HK"],
  probeCount: 3,
  timeoutMs: 8000,
  latencyWarnMs: 1500,
};
const HTTP3_TEST_HOST = 'cloudflare-quic.com';
const IPV6_TEST_HOST = 'api6.ipify.org';

function normalizeIP(value) {
  if (typeof value !== 'string') return null;
  try {
    if (value.includes(':')) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.split('.').some(part => +part > 255)) return null;
    return value.split('.').map(Number).join('.');
  } catch (_) { return null; }
}

function blockedRegion(country) {
  return ['CN', 'HK'].includes(country?.toUpperCase());
}

function applyExitPolicy(report, observations = []) {
  const exits = [...new Map([...(report.exits || []), ...observations].map(item => {
    const ip = normalizeIP(item.ip);
    const country = (item.countryCode || item.country || '').toUpperCase();
    const exit = { ip, country: /^[A-Z]{2}$/.test(country) ? country : null, source: item.source };
    return [`${ip}/${exit.country}/${exit.source}`, exit];
  }).filter(([, item]) => item.ip)).values()];
  const blocked = exits.filter(item => blockedRegion(item.country));
  const unknown = exits.filter(item => !item.country);
  const check = { name: '出口地区检查', status: blocked.length ? 'fail' : unknown.length || !exits.length ? 'info' : 'ok',
    blocking: blocked.length > 0,
    detail: blocked.length ? `禁止访问：${blocked.map(item => `${item.ip} · ${item.country === 'CN' ? '中国大陆' : '香港'} · ${item.source}`).join('；')}`
      : `${exits.length} 个参与地区拦截检查的出口中未发现中国大陆 / 香港 IP${unknown.length ? `；${unknown.length} 个出口地区未确认` : ''}；出口不同可能由分流产生，不据此判定异常` };
  return { ...report, exits, regionBlocked: blocked.length > 0,
    status: blocked.length ? 'fail' : report.networkStatus || report.status,
    ...(blocked.length ? { ready: false } : {}),
    checks: [...report.checks.filter(item => item.name !== check.name), check] };
}

function formatExit(trace) {
  return `${trace.ip} · ${trace.country} · ${trace.colo}`;
}

function sameExit(first, second) {
  const key = trace => `${trace.ip.includes(':') ? new URL(`http://[${trace.ip}]/`).hostname
    : trace.ip.split('.').map(Number).join('.')}/${trace.country}`;
  return key(first) === key(second);
}

function protectedHost(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "wss:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return VERIFICATION_DOMAINS.includes(host) || ROOT_DOMAINS.some(root => host === root || host.endsWith(`.${root}`)) ? host : null;
  } catch {
    return null;
  }
}

function hostFilter(host) {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^(https?|wss)://${escaped}\\.?(?::[0-9]+)?/`;
}

function parseTrace(body, expectedHost) {
  const fields = Object.fromEntries(body.split(/\r?\n/).filter(line => line.includes("=")).map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
  const ip = normalizeIP(fields.ip || '');
  if (!ip || !/^[A-Z]{2}$/i.test(fields.loc || "") || fields.h?.toLowerCase() !== expectedHost) {
    return null;
  }
  const protocol = /^http\/(?:1\.[01]|[23])$/i.test(fields.http || '') ? fields.http.toLowerCase() : null;
  return { ip, country: fields.loc.toUpperCase(), colo: fields.colo || "?", protocol };
}

function assessProbes(host, probes, settings = DEFAULT_SETTINGS) {
  const reachable = probes.filter(probe => probe.reachable);
  const traces = reachable.filter(probe => probe.trace).map(probe => probe.trace);
  const restricted = traces.find(trace => blockedRegion(trace.country));
  const trace = restricted || traces.at(-1);
  const changingExit = new Set(traces.map(item => `${item.ip}/${item.country}`)).size > 1;
  const protocols = [...new Set(traces.map(trace => trace.protocol).filter(Boolean))];
  const tcpTraces = traces.filter(trace => /^http\/(?:1\.[01]|2)$/.test(trace.protocol || ''));
  const http3Traces = traces.filter(trace => trace.protocol === 'http/3');
  const unknownTraces = traces.filter(trace => !trace.protocol);
  const http3Count = http3Traces.length;
  const canCompare = tcpTraces.length > 0 && http3Count > 0;
  const sameProtocolExit = new Set([...tcpTraces, ...http3Traces].map(item => `${item.ip}/${item.country}`)).size === 1;
  const comparison = canCompare
    ? sameProtocolExit ? 'TCP / HTTP/3 出口一致' : 'TCP / HTTP/3 出口不同，可能由分流产生，不代表异常'
    : 'TCP / HTTP/3 出口一致性未验证';
  const formatExits = items => [...new Map(items.map(item => [`${item.ip}/${item.country}`, item])).values()]
    .map(item => `${item.ip} · ${item.country} · ${item.colo}`).join('、') || '未验证';
  const exitDetail = [`目标站 ${host}`, `TCP：${formatExits(tcpTraces)}`, `HTTP/3：${formatExits(http3Traces)}`,
    ...(unknownTraces.length ? [`协议未知：${formatExits(unknownTraces)}`] : []), comparison].join('；');
  const failures = probes.length - reachable.length;
  const averageMs = reachable.length
    ? Math.round(reachable.reduce((sum, probe) => sum + probe.durationMs, 0) / reachable.length) : null;
  const checks = [
    {
      name: "域名 / TLS", status: reachable.length ? "ok" : "fail",
      detail: reachable.length
        ? `${host} 的浏览器 HTTPS 路径可用；DNS 可能由代理解析`
        : `无法建立 ${host} 的 HTTPS 路径：${probes[0]?.error || "连接失败"}`,
    },
    {
      name: "出口 IP / 地区", status: restricted ? "fail" : trace && canCompare && !changingExit ? "ok" : "info",
      detail: trace
        ? `${exitDetail}${restricted ? "；命中中国大陆 / 香港地区拦截规则" : changingExit ? "；探测期间出口不同，可能由分流产生" : traces.length < probes.length ? "；部分探测未确认出口" : ""}`
        : "目标域名未返回有效 trace，无法确认此域名的出口 IP / 地区",
    },
    {
      name: "HTTP 连通性", blocking: failures > 0 || reachable.some(probe => probe.status >= 500 || probe.status === 429), status: !reachable.length ? "fail"
        : failures || averageMs > settings.latencyWarnMs || reachable.some(probe => probe.status >= 500 || probe.status === 429) ? "warn" : "ok",
      detail: `${reachable.length}/${probes.length} 次获得响应${averageMs === null ? "" : ` · 平均 ${averageMs} ms`}；HTTP ${reachable.map(probe => probe.status).join(", ") || "无响应"}`,
    },
    {
      name: 'HTTP/3 / QUIC', blocking: false, status: http3Count ? 'ok' : 'info',
      detail: http3Count ? `${http3Count}/${probes.length} 次目标请求已使用 HTTP/3（QUIC / UDP）；出口按上方结果核对`
        : protocols.length ? `目标实际使用 ${protocols.map(protocol => protocol.toUpperCase()).join(', ')}；HTTP/3 未验证，浏览器可能回退到 TCP`
          : '目标未返回有效协议字段，HTTP/3 未验证；不能根据连接成功或 Alt-Svc 判断已使用 HTTP/3',
    },
  ];
  const networkStatus = !reachable.length ? 'fail'
    : failures || reachable.some(probe => probe.status >= 500 || probe.status === 429) ? 'warn' : 'ok';
  return applyExitPolicy({
    host, status: networkStatus, networkStatus,
    checks, trace: trace || null, probes, checkedAt: Date.now(),
  }, traces.map(item => ({ ...item, source: `目标站 ${host}（${item.protocol || 'HTTPS'}）` })));
}

async function probeHost(host, settings = DEFAULT_SETTINGS, fetchImpl = fetch) {
  if (protectedHost(`https://${host}/`) !== host) throw new Error("域名不在 Anthropic 保护范围内");
  const probes = await Promise.all(Array.from({ length: settings.probeCount }, async (_, index) => {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    const url = `https://${host}/cdn-cgi/trace?network_guard=${Date.now()}-${index}`;
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal, credentials: "omit", redirect: "manual",
        cache: "no-store", referrerPolicy: "no-referrer",
      });
      if (response.type === "opaqueredirect" || response.status === 0) {
        return { reachable: true, status: 302, durationMs: Math.round(performance.now() - start), trace: null };
      }
      const body = await response.text();
      return {
        reachable: true, status: response.status, durationMs: Math.round(performance.now() - start),
        trace: response.ok ? parseTrace(body, host) : null,
      };
    } catch (error) {
      return {
        reachable: false, durationMs: Math.round(performance.now() - start),
        error: controller.signal.aborted ? `超过 ${settings.timeoutMs / 1000} 秒` : error.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }));
  return assessProbes(host, probes, settings);
}

async function probeIPv6(settings = DEFAULT_SETTINGS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const result = { host: IPV6_TEST_HOST, ip: null };
  try {
    const response = await fetchImpl(`https://${IPV6_TEST_HOST}/?format=json`, {
      signal: controller.signal, credentials: 'omit', redirect: 'manual',
      cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`测试服务返回 HTTP ${response.status}`);
    const ip = normalizeIP((await response.json()).ip);
    if (!ip?.includes(':')) throw new Error('测试服务未返回有效 IPv6 地址');
    result.ip = ip;
  } catch (error) {
    result.error = controller.signal.aborted ? 'IPv6 探测超时' : error.message;
  } finally { clearTimeout(timer); }
  return result;
}

function withIPv6(report, result, observations = []) {
  const restricted = observations.find(item => normalizeIP(item.ip) === result.ip && blockedRegion(item.countryCode || item.country));
  const ipv6 = { ...result, countryCode: (restricted?.countryCode || restricted?.country || result.countryCode || '').toUpperCase() || null };
  const available = Boolean(ipv6.ip && ipv6.countryCode && !blockedRegion(ipv6.countryCode));
  const diagnostic = { name: 'IPv6 出口（第三方参考）', blocking: false,
    status: available ? 'ok' : 'warn',
    detail: (available ? '已检测到国外 IPv6 出口' : '未检测到国外 IPv6 出口，仅作警告')
      + '；' + (ipv6.ip ? `IPv6 出口：${ipv6.ip} · ${ipv6.countryCode || '地区未确认'}`
      : `IPv6 未验证；${ipv6.error || '未取得有效 IPv6 地址'}；请求失败不能确认 IPv6 是否可用`)
      + `；第三方参考：仅代表到 ${ipv6.host} 的 IPv6 出口，不代表 Anthropic，可能因分流而不同` };
  return { ...report, ipv6, checks: [...report.checks, diagnostic] };
}

async function probeThirdPartyHTTP3(settings = DEFAULT_SETTINGS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const result = { host: HTTP3_TEST_HOST, trace: null, traces: [] };
  try {
    // Sequential requests let the browser learn Alt-Svc before retrying QUIC.
    for (let index = 0; index < settings.probeCount; index++) {
      const response = await fetchImpl(`https://${HTTP3_TEST_HOST}/cdn-cgi/trace?network_guard=${Date.now()}-${index}`, {
        signal: controller.signal, credentials: 'omit', redirect: 'manual',
        cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      const trace = response.ok ? parseTrace(await response.text(), HTTP3_TEST_HOST) : null;
      if (trace) { result.trace = trace; result.traces.push(trace); }
      if (trace?.protocol === 'http/3' || blockedRegion(trace?.country)) break;
      if (controller.signal.aborted) break;
    }
  } catch (error) {
    result.error = controller.signal.aborted ? '探测超时' : error.message;
  } finally { clearTimeout(timer); }
  return result;
}

function withThirdPartyHTTP3(report, result) {
  const scope = `Cloudflare（${HTTP3_TEST_HOST}）；第三方参考，仅代表到测试站的出口，不代表 Anthropic，可能因分流而不同`;
  const trace = result.trace;
  const verified = trace?.protocol === 'http/3';
  const matches = verified && report.trace && sameExit(trace, report.trace);
  const reference = report.traceSource ? '参考出口' : '目标 HTTPS 出口';
  const comparison = !report.trace ? `${reference}未知，无法比较`
    : matches ? `与${reference}一致` : `与${reference}不同，可能由分流产生，不代表异常`;
  const diagnostic = { name: 'HTTP/3 / QUIC（第三方参考）', blocking: false,
    status: verified && matches ? 'ok' : 'info',
    detail: verified ? `HTTP/3 出口：${formatExit(trace)}；${comparison}；${scope}`
      : `${trace ? `测试站出口：${formatExit(trace)}；实际协议：${trace.protocol?.toUpperCase() || '未知'}；` : ''}HTTP/3 出口未验证${result.error ? `；${result.error}` : !trace ? '；测试站未返回有效出口信息' : ''}；${scope}` };
  const observations = (result.traces || (trace ? [trace] : [])).map(item => ({ ...item,
    source: `第三方 Cloudflare 测试站（${item.protocol || 'HTTPS'}）` }));
  const blocked = observations.find(item => blockedRegion(item.country));
  if (blocked) {
    diagnostic.status = 'fail'; diagnostic.blocking = true;
    diagnostic.detail += `；已检测到${blocked.country === 'CN' ? '中国大陆' : '香港'}出口，禁止访问`;
  }
  return applyExitPolicy({ ...report, thirdPartyHTTP3: result,
    checks: report.checks.map(check => check.name === 'HTTP/3 / QUIC' ? diagnostic : check) }, observations);
}

const api={ROOT_DOMAINS,VERIFICATION_DOMAINS,verificationHost,DEFAULT_SETTINGS,HTTP3_TEST_HOST,IPV6_TEST_HOST,normalizeIP,blockedRegion,applyExitPolicy,protectedHost,hostFilter,parseTrace,assessProbes,probeHost,probeIPv6,withIPv6,probeThirdPartyHTTP3,withThirdPartyHTTP3};
root.NotmeNetwork=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();
