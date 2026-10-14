/* notme — UDP/STUN diagnostics under the current WebRTC policy. */
(function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : globalThis;
  const STUN_SERVER = 'stun:stun.cloudflare.com:3478';

  function normalizeIP(value) {
    if (typeof value !== 'string') return null;
    try {
      if (value.includes(':')) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.split('.').some(part => +part > 255)) return null;
      return value.split('.').map(Number).join('.');
    } catch (_) { return null; }
  }

  function candidateIP(candidate) {
    const parts = candidate.candidate?.split(/\s+/) || [];
    const protocol = candidate.protocol || parts[2];
    const type = candidate.type || parts[parts.indexOf('typ') + 1];
    if (protocol?.toLowerCase() !== 'udp' || type !== 'srflx') return null;
    return normalizeIP(candidate.address || parts[4]);
  }

  async function probe(options = {}) {
    const policy = options.policy;
    if (policy === 'disable_non_proxied_udp') return { state: 'restricted', ips: [], policy };
    const Peer = options.PeerConnection || root.RTCPeerConnection;
    if (!Peer) return { state: 'unsupported', ips: [], policy };
    const start = performance.now();
    return new Promise(resolve => {
      const ips = new Set();
      let peer;
      let done = false;
      const finish = error => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (peer) { peer.onicecandidate = peer.onicegatheringstatechange = null; peer.close(); }
        resolve({ state: ips.size ? 'available' : 'unknown', ips: [...ips], policy,
          durationMs: Math.round(performance.now() - start), ...(error ? { error } : {}) });
      };
      const timer = setTimeout(() => finish('STUN 探测超时'), options.timeoutMs ?? 4000);
      (async () => {
        try {
          peer = new Peer({ iceServers: [{ urls: options.server || STUN_SERVER }] });
          peer.onicecandidate = event => {
            if (!event.candidate) return finish();
            const ip = candidateIP(event.candidate);
            if (ip) ips.add(ip);
          };
          peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') finish(); };
          peer.createDataChannel('notme-network-test');
          await peer.setLocalDescription(await peer.createOffer());
        } catch (error) { finish(error.message); }
      })();
    });
  }

  function assess(result, targetIP) {
    const base = { name: 'UDP / STUN', blocking: false };
    const scope = '第三方参考：到 Cloudflare STUN 测试服务的 UDP 出口，不代表 Anthropic，可能因分流而不同';
    if (result?.state === 'restricted' && result.policy === 'disable_non_proxied_udp') {
      return { ...base, status: 'ok', detail: `WebRTC 防泄漏保护已生效；已限制 WebRTC 绕过代理的 UDP 连接，未发送 STUN；${scope}` };
    }
    if (result?.state === 'unsupported') return { ...base, status: 'info', detail: `浏览器不提供 WebRTC，无法验证 UDP；${scope}` };
    const ips = [...new Set((result?.ips || []).map(normalizeIP).filter(Boolean))];
    if (result?.state !== 'available' || !ips.length) return { ...base, status: 'info',
      detail: `未取得 STUN 响应，UDP 未验证；可能是网络、浏览器策略或测试服务限制；${scope}` };
    const region = ip => result.regions?.find(item => normalizeIP(item.ip) === ip)?.countryCode || null;
    const detail = ips.map(ip => `${ip} · ${region(ip) || '地区未确认'}`).join('、');
    const blocked = ips.filter(ip => ['CN', 'HK'].includes(region(ip)?.toUpperCase()));
    if (blocked.length) return { ...base, blocking: true, status: 'fail',
      detail: `UDP 出口：${detail}；检测到中国大陆 / 香港 IP，禁止访问；${scope}` };
    const target = normalizeIP(targetIP);
    if (!target) return { ...base, status: 'info', detail: `UDP 响应成功 · ${detail}；目标 HTTPS 出口未知，无法比较；${scope}` };
    const sameExit = ips.every(ip => ip === target);
    return { ...base, status: sameExit ? 'ok' : 'info', detail: sameExit
      ? `UDP 响应成功 · ${detail} · 与目标 HTTPS 出口一致；${scope}`
      : `UDP 出口 ${detail} 与目标 HTTPS 出口 ${target} 不同，可能由分流产生，不代表异常；${scope}` };
  }

  const api = { STUN_SERVER, normalizeIP, candidateIP, probe, assess };
  root.NotmeUDP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
