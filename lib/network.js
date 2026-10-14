/* notme — target-domain network preflight. */
(function () {
'use strict';
const root = typeof self !== 'undefined' ? self : globalThis;
const ROOT_DOMAINS = [
  "anthropic.com", "claude.ai", "claude.com", "claude.app",
  "claudeusercontent.com", "claudemcpcontent.com", "claude.site",
];

const DEFAULT_SETTINGS = {
  blockedCountries: ["CN", "HK", "KP", "CU", "IR", "SY", "RU", "BY"],
  probeCount: 3,
  timeoutMs: 8000,
  latencyWarnMs: 500,
};

function protectedHost(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "wss:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return ROOT_DOMAINS.some(root => host === root || host.endsWith(`.${root}`)) ? host : null;
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
  const ip = fields.ip || "";
  let validIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every(part => Number(part) <= 255);
  if (ip.includes(":")) {
    try { validIP = new URL(`http://[${ip}]/`).hostname.startsWith("["); } catch { validIP = false; }
  }
  if (!validIP || !/^[A-Z]{2}$/i.test(fields.loc || "") || fields.h?.toLowerCase() !== expectedHost) {
    return null;
  }
  return { ip, country: fields.loc.toUpperCase(), colo: fields.colo || "?" };
}

function assessProbes(host, probes, settings = DEFAULT_SETTINGS) {
  const reachable = probes.filter(probe => probe.reachable);
  const traces = reachable.filter(probe => probe.trace).map(probe => probe.trace);
  const restricted = traces.find(trace => settings.blockedCountries.includes(trace.country));
  const trace = restricted || traces[0];
  const changingExit = new Set(traces.map(item => `${item.ip}/${item.country}`)).size > 1;
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
      name: "出口 IP / 地区", status: restricted ? "fail" : trace && traces.length === probes.length && !changingExit ? "ok" : "warn",
      detail: trace
        ? `${trace.ip} · ${trace.country} · ${trace.colo}${restricted ? "；命中地区拦截规则" : changingExit ? "；探测期间出口发生变化" : traces.length < probes.length ? "；部分探测未确认出口" : ""}`
        : "目标域名未返回有效 trace，无法确认此域名的出口 IP / 地区",
    },
    {
      name: "HTTP 连通性", status: !reachable.length ? "fail"
        : failures || averageMs > settings.latencyWarnMs || reachable.some(probe => probe.status >= 500 || probe.status === 429) ? "warn" : "ok",
      detail: `${reachable.length}/${probes.length} 次获得响应${averageMs === null ? "" : ` · 平均 ${averageMs} ms`}；HTTP ${reachable.map(probe => probe.status).join(", ") || "无响应"}`,
    },
  ];
  return {
    host, status: checks.some(check => check.status === "fail") ? "fail"
      : checks.some(check => check.status === "warn") ? "warn" : "ok",
    checks, trace: trace || null, probes, checkedAt: Date.now(),
  };
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

const api={ROOT_DOMAINS,DEFAULT_SETTINGS,protectedHost,hostFilter,parseTrace,assessProbes,probeHost};
root.NotmeNetwork=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();
