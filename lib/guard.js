/* notme — per-navigation admission, with no browser-session main-page allowlist. */
(function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : globalThis;
  const Network = root.NotmeNetwork;
  const PREFIX = 'NOTME_GUARD_';
  const PROBE_ID = 20000;
  const ENTRY_PRIORITY = 2000;
  const RESOURCE_PRIORITY = 2000;
  const PROFILE_PRIORITY = 3000;
  const ALLOW_AGE_MS = 60000;
  const QUICK_CONFIRM_MS = 15000;
  let data;
  let queue = Promise.resolve();
  const running = new Map();
  const confirmations = new Map();

  const initialized = chrome.storage.session.get('guard').then(async saved => {
    data = saved.guard || { tabs: {}, nextId: 20100 };
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    // Pending admission rules must never survive a worker restart.
    for (const tab of Object.values(data.tabs)) {
      tab.entryId = null;
      if (tab.phase === 'admitting') tab.phase = 'checking';
    }
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.filter(rule => rule.id >= PROBE_ID).map(rule => rule.id),
      addRules: [{
        id: PROBE_ID, priority: ENTRY_PRIORITY,
        action: { type: 'allow' },
        condition: { initiatorDomains: [chrome.runtime.id], requestDomains: Network.ROOT_DOMAINS,
          regexFilter: '^https://[^/]+/cdn-cgi/trace(?:\\?.*)?$', resourceTypes: ['xmlhttprequest'], requestMethods: ['get'] },
      }, ...Object.entries(data.tabs).flatMap(([id, tab]) => tab.phase === 'active' ? resourceRules(Number(id), tab) : [])],
    });
  });

  function update(task) {
    const work = queue.then(() => initialized).then(task).then(async value => {
      await chrome.storage.session.set({ guard: data });
      return value;
    });
    queue = work.catch(error => console.error('notme gate:', error));
    return work;
  }

  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(info => {
    if (info.rule.rulesetId !== 'navigation_guard' || ![1, 3].includes(info.rule.ruleId) || info.request.tabId < 0) return;
    void update(async () => {
      const tabId = info.request.tabId;
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url?.startsWith('http') || Network.protectedHost(tab.url)) return;
      data.blockNotices ||= {};
      if (data.blockNotices[tabId]) return;
      data.blockNotices[tabId] = true;
      const source = new URL(tab.url).hostname;
      const destination = new URL(info.request.url).hostname;
      const message = source + ' 向 ' + destination + ' 的请求已被 notme 拦截，检测结果可能显示不可访问。出口诊断接口已放行；访问正式网站需先检查并确认。';
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b45309' });
      await chrome.action.setTitle({ tabId, title: message });
      await chrome.notifications.create('notme-block-' + tabId, { type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'notme 已拦截网站请求', message }).catch(() => {});
    }).catch(() => {});
  });

  function resourceRules(tabId, tab) {
    if (!tab.resourceId || !tab.override) return [];
    const headers = [
      ...(tab.override.langEnabled ? [{ header: 'accept-language', operation: 'set', value: tab.override.acceptLanguage }] : []),
      ...(tab.override.identityEnabled ? NotmeIdentity.requestHeaders(root.notmeGuardIdentity()) : []),
    ];
    return [{
      id: tab.resourceId, priority: RESOURCE_PRIORITY, action: { type: 'allow' },
      condition: { tabIds: [tabId], excludedResourceTypes: ['main_frame'] },
    }, ...(headers.length ? [{
      id: tab.headerId, priority: PROFILE_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { tabIds: [tabId], ...(Network.verificationHost(tab.target)
        ? { regexFilter: Network.hostFilter(Network.verificationHost(tab.target)) }
        : { requestDomains: Network.ROOT_DOMAINS }), resourceTypes: [
        'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
        'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
      ] },
    }] : [])];
  }

  function ruleIds(tab) { return [tab?.entryId, tab?.resourceId, tab?.headerId].filter(Boolean); }

  function snapshot(tab) {
    return tab ? { target: tab.target, host: Network.protectedHost(tab.target), report: tab.report || null,
      phase: tab.phase, navigationId: tab.navigationId, selection: tab.selection || null, override: tab.override || null } : null;
  }

  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return;
    const host = Network.protectedHost(details.url);
    void update(async () => {
      if (data.blockNotices) delete data.blockNotices[details.tabId];
      await chrome.action.setBadgeText({ tabId: details.tabId, text: '' });
      await chrome.action.setTitle({ tabId: details.tabId, title: 'notme' });
      confirmations.delete(details.tabId);
      const old = data.tabs[details.tabId];
      if (host && old?.phase === 'admitting' && host === Network.protectedHost(old.target)) return;
      if (old && ruleIds(old).length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(old) });
      if (!host) {
        if (!details.url.startsWith(chrome.runtime.getURL('gate.html'))) delete data.tabs[details.tabId];
        else if (old) { old.phase = 'checking'; old.entryId = old.resourceId = old.headerId = null; }
        return;
      }
      data.tabs[details.tabId] = { target: details.url, phase: 'checking', navigationId: crypto.randomUUID() };
      await chrome.browsingData.remove({ origins: [new URL(details.url).origin] }, { serviceWorkers: true, cacheStorage: true });
    });
  });

  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId !== 0 || !Network.protectedHost(details.url)) return;
    void update(async () => {
      const tab = data.tabs[details.tabId];
      if (tab?.phase === 'admitting' && tab.entryId) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab.entryId] });
        tab.entryId = null;
        tab.phase = 'active';
      } else if (tab?.phase === 'checking') {
        await chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('gate.html') + '#target=' + encodeURIComponent(tab.target) });
      }
    });
  });

  chrome.webNavigation.onErrorOccurred.addListener(details => {
    if (details.frameId !== 0 || !Network.protectedHost(details.url)) return;
    void update(async () => {
      const tab = data.tabs[details.tabId];
      if (tab?.phase === 'checking' && tab.target === details.url) {
        await chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('gate.html') + '#target=' + encodeURIComponent(tab.target) });
      }
    });
  });

  chrome.tabs.onRemoved.addListener(tabId => { void update(async () => {
    const tab = data.tabs[tabId];
    if (ruleIds(tab).length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(tab) });
    confirmations.delete(tabId);
    delete data.tabs[tabId];
    if (data.blockNotices) delete data.blockNotices[tabId];
  }); });

  async function inspectNetwork(target, settings, selection) {
    const observations = [];
    const observe = source => location => {
      const ip = Network.normalizeIP(location.ip);
      if (ip) observations.push({ ip, countryCode: location.countryCode,
        source: `${source}（${location.provider || '地理查询服务'}）` });
    };
    const networkSettings = { ...Network.DEFAULT_SETTINGS,
      latencyWarnMs: settings.networkWarnMs || Network.DEFAULT_SETTINGS.latencyWarnMs };
    const verification = Network.verificationHost(target);
    const locationTask = root.IPLoc.getIPLocation(settings.ipToken, observe('第三方查 IP 服务'));
    const targetTask = Network.probeHost(verification ? 'claude.ai' : Network.protectedHost(target), networkSettings);
    const preparedTask = targetTask.then(network => root.notmePrepareEnvironment(network, settings, selection, observe('目标 IP 地区查询，第三方参考')));
    const [reference, thirdPartyHTTP3, , prepared] = await Promise.all([
      targetTask, Network.probeThirdPartyHTTP3(networkSettings), locationTask, preparedTask,
    ]);
    let network = Network.withThirdPartyHTTP3(reference, thirdPartyHTTP3);
    network = Network.applyExitPolicy(network, observations);
    return { override: prepared.override,
      report: { ...network, id: crypto.randomUUID(), diagnosticsComplete: false, profileReady: Boolean(prepared.override), ready: false,
        checks: [...network.checks, ...prepared.checks], environmentChecks: prepared.checks,
        checkedAt: Date.now() } };
  }

  async function inspectUDP(report, udp, settings) {
    if (!udp) throw new Error('请完成 UDP 出口检查');
    const observations = [];
    const ips = [...new Set((udp.ips || []).map(root.NotmeUDP.normalizeIP).filter(Boolean))];
    const regions = await Promise.all(ips.map(async ip => {
      const location = await root.IPLoc.getCountryForIP(ip, settings.ipToken, item => observations.push({
        ip: item.ip, countryCode: item.countryCode, source: `第三方 STUN 出口地区查询（${item.provider}）` }));
      observations.push({ ip, countryCode: location?.countryCode, source: '第三方 Cloudflare UDP / STUN 出口' });
      return { ip, countryCode: location?.countryCode || null };
    }));
    const checked = Network.applyExitPolicy({ ...report, udp: { ...udp, regions },
      checks: [...report.checks.filter(item => item.name !== 'UDP / STUN'), root.NotmeUDP.assess({ ...udp, regions }, report.trace?.ip)] }, observations);
    return { ...checked, diagnosticsComplete: true,
      ready: checked.status === 'ok' && checked.profileReady, checkedAt: Date.now() };
  }

  async function recordExit(tab, report) {
    const ip = Network.normalizeIP(report.trace?.ip);
    if (!ip) return;
    const host = report.host;
    const { targetExitRecords = {} } = await chrome.storage.local.get('targetExitRecords');
    const saved = targetExitRecords[host];
    const history = Array.isArray(saved) ? saved : saved ? [saved] : [];
    if (!Object.hasOwn(tab, 'previousExit')) tab.previousExit = history[0] || null;
    const current = { ip, checkedAt: report.checkedAt, visitId: tab.navigationId };
    report.exitRecord = { previous: tab.previousExit, current,
      changed: Boolean(tab.previousExit && tab.previousExit.ip !== ip) };
    targetExitRecords[host] = [current, ...history.filter(item => item.visitId !== tab.navigationId)].slice(0, 10);
    report.exitRecord.history = targetExitRecords[host].map(({ ip, checkedAt }) => ({ ip, checkedAt }));
    await chrome.storage.local.set({ targetExitRecords });
  }

  async function check(tabId, requestedSelection) {
    await initialized;
    await queue;
    const tab = data.tabs[tabId];
    if (!tab) throw new Error('没有待检查的网址，请从地址栏重新打开目标网站');
    if (tab.phase !== 'checking') throw new Error('页面已放行，请重新打开目标网址进行检查');
    const settings = await root.notmeGuardSettings();
    const selection = root.NotmeEnvironment.normalizeSelection(requestedSelection, settings);
    const key = tab.navigationId + JSON.stringify(selection) + root.NotmeEnvironment.settingsFingerprint(settings);
    await update(() => { confirmations.delete(tabId); tab.checkKey = key; tab.report = null; tab.override = null; });
    if (running.has(key)) return running.get(key);
    const navigationId = tab.navigationId;
    const work = (async () => {
      const prepared = await inspectNetwork(tab.target, settings, selection);
      await update(async () => {
        if (data.tabs[tabId]?.navigationId !== navigationId || tab.checkKey !== key) throw new Error('网址或环境选择已改变，请重新检查');
        await recordExit(tab, prepared.report);
        tab.report = prepared.report;
        tab.override = prepared.override;
        tab.selection = selection;
        tab.settingsFingerprint = root.NotmeEnvironment.settingsFingerprint(settings);
      });
      return snapshot(tab);
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  }

  async function prepareConfirmation(tabId, navigationId, selection) {
    const tab = data.tabs[tabId];
    const settings = await root.notmeGuardSettings();
    if (tab && tab.settingsFingerprint !== root.NotmeEnvironment.settingsFingerprint(settings)) throw new Error('notme 设置已变化，请重新检查并确认');
    if (!tab?.report?.ready || tab.phase !== 'checking' || tab.navigationId !== navigationId
      || tab.settingsFingerprint !== root.NotmeEnvironment.settingsFingerprint(settings)
      || JSON.stringify(root.NotmeEnvironment.normalizeSelection(selection, settings)) !== JSON.stringify(tab.selection)) {
      throw new Error('环境检查已失效，请重新检查');
    }
    const reportId = tab.report.id;
    const token = crypto.randomUUID();
    confirmations.set(tabId, { token });
    const fresh = await inspectNetwork(tab.target, settings, tab.selection);
    return update(() => {
      if (confirmations.get(tabId)?.token !== token || data.tabs[tabId]?.navigationId !== navigationId
        || tab.report?.id !== reportId || tab.phase !== 'checking') throw new Error('这次复查已失效，请重新检查');
      confirmations.set(tabId, { token, navigationId, reportId, fresh, createdAt: Date.now() });
      return token;
    });
  }

  async function confirm(tabId, navigationId, requestedSelection, udp, token) {
    await initialized;
    await queue;
    const tab = data.tabs[tabId];
    if (!tab || tab.navigationId !== navigationId || tab.phase !== 'checking') throw new Error('这次检查已失效，请重新检查');
    if (!tab.report?.ready || !tab.report.diagnosticsComplete || !tab.override) throw new Error('环境检查未通过，不能访问正式页面');
    const reportId = tab.report.id;
    if (JSON.stringify(root.NotmeEnvironment.normalizeSelection(requestedSelection, await root.notmeGuardSettings())) !== JSON.stringify(tab.selection)) {
      throw new Error('环境选择已改变，请重新检查并确认');
    }
    async function verifyEnvironment() {
      const settings = await root.notmeGuardSettings();
      if (root.NotmeEnvironment.settingsFingerprint(settings) !== tab.settingsFingerprint) {
        await update(() => { tab.report.ready = false; });
        throw new Error('notme 设置已变化，请重新检查并确认');
      }
      return settings;
    }
    const settings = await verifyEnvironment();
    let fresh = { report: tab.report, override: tab.override };
    if (token) {
      const pending = confirmations.get(tabId);
      confirmations.delete(tabId);
      if (!pending?.fresh || pending.token !== token || pending.navigationId !== navigationId
        || pending.reportId !== reportId || Date.now() - pending.createdAt > ALLOW_AGE_MS) {
        throw new Error('这次复查已失效，请重新检查');
      }
      fresh = pending.fresh;
      fresh.report = await inspectUDP(fresh.report, udp, settings);
      await update(async () => {
        if (data.tabs[tabId]?.navigationId !== navigationId || tab.report?.id !== reportId || tab.phase !== 'checking') {
          throw new Error('这次检查已失效，请重新检查');
        }
        await recordExit(tab, fresh.report);
        tab.report = fresh.report; tab.override = fresh.override;
      });
      if (!fresh.report.ready) throw new Error(fresh.report.regionBlocked
        ? '检测到中国大陆 / 香港出口，禁止访问；请重新检查' : '网络或所选环境检查未通过，请重新检查');
    } else if (Date.now() - tab.report.checkedAt > QUICK_CONFIRM_MS) {
      return { recheck: true };
    }
    await verifyEnvironment();
    await update(async () => {
      if (data.tabs[tabId]?.navigationId !== navigationId || tab.report?.id !== fresh.report.id || tab.phase !== 'checking') throw new Error('这次检查已失效，请重新检查');
      tab.entryId = data.nextId++;
      tab.resourceId = data.nextId++;
      tab.headerId = tab.selection.langEnabled || tab.selection.identityEnabled ? data.nextId++ : null;
      const entry = {
        id: tab.entryId, priority: ENTRY_PRIORITY, action: { type: 'allow' },
        condition: { tabIds: [tabId], initiatorDomains: [chrome.runtime.id],
          regexFilter: Network.hostFilter(Network.protectedHost(tab.target)), resourceTypes: ['main_frame'], requestMethods: ['get'] },
      };
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [entry, ...resourceRules(tabId, tab)] });
      tab.phase = 'admitting';
    });
    const destination = new URL(tab.target);
    const payload = { hash: destination.hash, profile: tab.override, identity: root.notmeGuardIdentity() };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    destination.hash = '__notme_entry=' + btoa(String.fromCharCode(...bytes));
    return destination.href;
  }

  function handles(message) { return Boolean(message?.type?.startsWith(PREFIX)); }
  async function message(request, sender) {
    await initialized;
    await queue;
    if (sender.id !== chrome.runtime.id) throw new Error('消息来源无效');
    if (request.type === PREFIX + 'PROFILE') return data.tabs[sender.tab?.id]?.override || null;
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('操作只能从 notme 检查页执行');
    const tabId = request.tabId;
    switch (request.type) {
      case PREFIX + 'STATE': {
        if (!data.tabs[tabId] && request.target) {
          const current = await chrome.tabs.get(tabId);
          const gate = new URL(current.url);
          const target = new URLSearchParams(gate.hash.slice(1)).get('target');
          if (gate.origin !== new URL(chrome.runtime.getURL('')).origin || gate.pathname !== '/gate.html'
            || target !== request.target || !Network.protectedHost(target)
            || !['http:', 'https:'].includes(new URL(target).protocol)) throw new Error('恢复网址无效');
          await update(() => { data.tabs[tabId] = { target, phase: 'checking', navigationId: crypto.randomUUID() }; });
        }
        const view = snapshot(data.tabs[tabId]);
        return view ? { ...view, defaults: root.NotmeEnvironment.defaultSelection(await root.notmeGuardSettings()) } : null;
      }
      case PREFIX + 'CHECK': return check(tabId, request.selection);
      case PREFIX + 'UDP': {
        const tab = data.tabs[tabId];
        if (!tab?.report || tab.report.id !== request.checkId || tab.navigationId !== request.navigationId
          || JSON.stringify(tab.selection) !== JSON.stringify(request.selection)) throw new Error('环境选择已改变，请重新检查');
        const checked = await inspectUDP(tab.report, request.udp, await root.notmeGuardSettings());
        return update(() => {
          if (data.tabs[tabId]?.report?.id !== request.checkId || tab.navigationId !== request.navigationId
            || tab.phase !== 'checking') throw new Error('环境选择已改变，请重新检查');
          tab.report = checked;
          return snapshot(tab);
        });
      }
      case PREFIX + 'PREPARE_CONFIRM': return prepareConfirmation(tabId, request.navigationId, request.selection);
      case PREFIX + 'CONFIRM': return confirm(tabId, request.navigationId, request.selection, request.udp, request.token);
      default: throw new Error('未知操作');
    }
  }
  root.NotmeGuard = { handles, message };
})();
