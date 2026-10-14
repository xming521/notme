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
  let data;
  let queue = Promise.resolve();
  const running = new Map();

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
      condition: { tabIds: [tabId], resourceTypes: [
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
        await chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('gate.html') });
      }
    });
  });

  chrome.webNavigation.onErrorOccurred.addListener(details => {
    if (details.frameId !== 0 || !Network.protectedHost(details.url)) return;
    void update(async () => {
      const tab = data.tabs[details.tabId];
      if (tab?.phase === 'checking' && tab.target === details.url) {
        await chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('gate.html') });
      }
    });
  });

  chrome.tabs.onRemoved.addListener(tabId => { void update(async () => {
    const tab = data.tabs[tabId];
    if (ruleIds(tab).length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds(tab) });
    delete data.tabs[tabId];
  }); });

  async function check(tabId, requestedSelection) {
    await initialized;
    await queue;
    const tab = data.tabs[tabId];
    if (!tab) throw new Error('没有待检查的网址，请从地址栏重新打开目标网站');
    if (tab.phase !== 'checking') throw new Error('页面已放行，请重新打开目标网址进行检查');
    const settings = await root.notmeGuardSettings();
    const selection = root.NotmeEnvironment.normalizeSelection(requestedSelection, settings);
    const key = tab.navigationId + JSON.stringify(selection);
    await update(() => { tab.checkKey = key; tab.report = null; tab.override = null; });
    if (running.has(key)) return running.get(key);
    const navigationId = tab.navigationId;
    const work = (async () => {
      const network = await Network.probeHost(Network.protectedHost(tab.target), {
        ...Network.DEFAULT_SETTINGS, latencyWarnMs: settings.networkWarnMs || Network.DEFAULT_SETTINGS.latencyWarnMs,
      });
      const prepared = await root.notmePrepareEnvironment(network, settings, selection);
      const report = { ...network, checks: [...network.checks, ...prepared.checks],
        ready: root.NotmeEnvironment.ready(network, prepared.checks), checkedAt: Date.now() };
      await update(() => {
        if (data.tabs[tabId]?.navigationId !== navigationId || tab.checkKey !== key) throw new Error('网址或环境选择已改变，请重新检查');
        tab.report = report;
        tab.override = prepared.override;
        tab.selection = selection;
        tab.settingsFingerprint = root.NotmeEnvironment.settingsFingerprint(settings);
      });
      return snapshot(tab);
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  }

  async function confirm(tabId, navigationId, requestedSelection) {
    await initialized;
    await queue;
    const tab = data.tabs[tabId];
    if (!tab || tab.navigationId !== navigationId || tab.phase !== 'checking') throw new Error('这次检查已失效，请重新检查');
    if (!tab.report?.ready || !tab.override) throw new Error('环境检查未通过，不能访问正式页面');
    if (JSON.stringify(root.NotmeEnvironment.normalizeSelection(requestedSelection, await root.notmeGuardSettings())) !== JSON.stringify(tab.selection)) {
      throw new Error('环境选择已改变，请重新检查并确认');
    }
    if (Date.now() - tab.report.checkedAt > ALLOW_AGE_MS) throw new Error('检查已超过一分钟，请重新检查后确认');
    async function verifyEnvironment() {
      const settings = await root.notmeGuardSettings();
      if (root.NotmeEnvironment.settingsFingerprint(settings) !== tab.settingsFingerprint) {
        await update(() => { tab.report.ready = false; });
        throw new Error('notme 设置已变化，请重新检查并确认');
      }
      return settings;
    }
    const settings = await verifyEnvironment();
    const fresh = await Network.probeHost(Network.protectedHost(tab.target), {
      ...Network.DEFAULT_SETTINGS, latencyWarnMs: settings.networkWarnMs || Network.DEFAULT_SETTINGS.latencyWarnMs,
    });
    if (fresh.status !== 'ok' || fresh.trace?.ip !== tab.report.trace?.ip || fresh.trace?.country !== tab.report.trace?.country) {
      await update(() => { tab.report.ready = false; });
      throw new Error('出口或连接状态已变化，请重新检查并确认');
    }
    await verifyEnvironment();
    await root.notmeGuardWebRTC(tab.selection.webrtcProtect);
    await update(async () => {
      if (data.tabs[tabId]?.navigationId !== navigationId || tab.phase !== 'checking') throw new Error('这次检查已失效，请重新检查');
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
        const view = snapshot(data.tabs[tabId]);
        return view ? { ...view, defaults: root.NotmeEnvironment.defaultSelection(await root.notmeGuardSettings()) } : null;
      }
      case PREFIX + 'CHECK': return check(tabId, request.selection);
      case PREFIX + 'UDP': return update(() => {
        const tab = data.tabs[tabId];
        if (!tab?.report || tab.navigationId !== request.navigationId
          || JSON.stringify(tab.selection) !== JSON.stringify(request.selection)) throw new Error('环境选择已改变，请重新检查');
        tab.report.checks = [...tab.report.checks.filter(check => check.name !== 'UDP / STUN'),
          root.NotmeUDP.assess(request.udp, tab.report.trace?.ip)];
        return snapshot(tab);
      });
      case PREFIX + 'CONFIRM': return confirm(tabId, request.navigationId, request.selection);
      default: throw new Error('未知操作');
    }
  }
  root.NotmeGuard = { handles, message };
})();
