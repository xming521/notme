/* GeoMirror — background service worker.
 *
 * Responsibilities:
 *  - Detect the exit-IP geolocation (through the user's proxy).
 *  - Pick a nearby residential street as the override coordinate.
 *  - Resolve the exit IP's timezone (already returned by the IP providers) and
 *    infer a matching locale (country code → language, timezone as tie-breaker).
 *  - Store everything for the selected Anthropic page.
 *  - Push an Accept-Language header rule via declarativeNetRequest so the
 *    *outgoing* HTTP header matches the spoofed language, not just navigator.
 *  - Refresh on install / startup and on demand (one-tap re-detect).
 */
importScripts('lib/geo.js', 'lib/providers.js', 'lib/locale.js', 'lib/tzdata.js', 'lib/identity.js', 'lib/network.js', 'lib/environment.js', 'lib/udp.js');

const DEFAULT_SETTINGS = {
  enabled: true,
  accuracyM: 30,          // reported accuracy in meters (GPS-like)
  refreshMinutes: 360,    // re-detect every 6h
  ipToken: '',            // optional ipinfo.io token for better fallback
  tzEnabled: true,        // spoof Date/Intl timezone to match exit IP
  langEnabled: true,      // spoof navigator.language / Intl locale + Accept-Language header
  webrtcProtect: true,    // disable WebRTC connections only on the selected page
  fontEnabled: true,      // hide OS/region-revealing CJK fonts from width probing
  identityEnabled: false, // legacy preference; per-visit selection controls identity
  workerEnabled: false,   // (experimental) spoof inside Web Workers — off by default:
                          // rewriting a worker through a blob can break WASM/bundled
                          // workers that rely on self.location. Opt in if you need it.
  manualTz: '',           // fallback IANA timezone used when exit-IP detection fails
                          // (or a provider returns no timezone). Empty = auto only.
  networkWarnMs: 1500,
};

const ALARM = 'refresh';
const LEGACY_HEADER_RULE_IDS = [9001, 9002, 9003, 9004, 9005];
const IDENTITY_PROFILE = NotmeIdentity.fromNavigator(typeof navigator !== 'undefined' ? navigator : {});

async function getSettings() {
  await legacyCleanup;
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function patchState(patch) {
  const { state } = await chrome.storage.local.get('state');
  await chrome.storage.local.set({ state: { ...(state || {}), ...patch } });
}

async function clearLegacyEffects() {
  await chrome.storage.local.set({ identityProfile: IDENTITY_PROFILE });
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: LEGACY_HEADER_RULE_IDS, addRules: [] });
  await chrome.storage.session.remove('guardWebRTCProtect');
  if (chrome.privacy?.network?.webRTCIPHandlingPolicy) await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
}
async function migrateNetworkWarning() {
  const { settings, networkWarnDefaultMigrated } = await chrome.storage.local.get(['settings', 'networkWarnDefaultMigrated']);
  if (networkWarnDefaultMigrated) return;
  const patch = { networkWarnDefaultMigrated: true };
  if (settings?.networkWarnMs === 500) patch.settings = { ...settings, networkWarnMs: DEFAULT_SETTINGS.networkWarnMs };
  await chrome.storage.local.set(patch);
}
const legacyCleanup = Promise.all([clearLegacyEffects(), migrateNetworkWarning()]);

/** Build an override from the user's manual timezone (fallback when the exit-IP
 *  path can't confirm a timezone). Coordinates come from the timezone's profile
 *  city (jittered) so geolocation stays consistent; locale is inferred the same
 *  way as the auto path. */
function buildManualOverride(s, now, note) {
  const prof = TZData.profileForTz(s.manualTz);
  const j = (prof.lat != null) ? GeoUtil.jitterCoord(prof.lat, prof.lon, 300, 1500) : null;
  const loc = Locale.localeFor(prof.cc, s.manualTz);
  const override = {
    lat: j ? j.lat : null, lon: j ? j.lon : null, acc: s.accuracyM,
    source: 'manual', road: null, enabled: s.enabled, ts: now,
    timezone: s.manualTz, tzEnabled: s.tzEnabled, langEnabled: s.langEnabled,
    locale: loc ? loc.language : null,
    languages: loc ? loc.languages : null,
    acceptLanguage: loc ? loc.acceptLanguage : null,
  };
  const state = {
    status: 'manual',
    ip: null, ipCity: null, ipRegion: null, ipCountry: null, ipCountryCode: prof.cc,
    ipLat: null, ipLon: null, isp: null, provider: null,
    ipTimezone: s.manualTz, tzSource: 'manual', ipLocale: loc ? loc.language : null,
    overrideLat: override.lat, overrideLon: override.lon,
    overrideSource: 'manual', overrideRoad: null,
    overrideAddress: prof.label || s.manualTz,
    lastUpdated: now, lastError: note || null,
  };
  return { override, state };
}

async function refresh() {
  await patchState({ status: 'refreshing', lastError: null });
  const s = await getSettings();
  const now = Date.now();

  // A manually chosen timezone is FORCED: it overrides exit-IP detection so you
  // can present a fixed non-China profile even when the exit IP resolves to China
  // (or detection fails). Auto-detection runs only when the manual zone is blank.
  if (s.manualTz) {
    const { override, state } = buildManualOverride(s, now, null);
    // Best-effort: still look up the real exit IP so the popup can show it (and
    // flag when the forced timezone contradicts the real exit location).
    try {
      const ip = await IPLoc.getIPLocation(s.ipToken);
      if (ip && ip.ip) {
        state.ip = ip.ip; state.ipCity = ip.city; state.ipRegion = ip.region;
        state.ipCountry = ip.country; state.isp = ip.isp; state.provider = ip.provider;
        state.realTimezone = ip.timezone || null;
        state.mismatch = !!(ip.timezone && ip.timezone !== s.manualTz);
      }
    } catch (_) {}
    await chrome.storage.local.set({ override, state });

    return;
  }

  try {
    // Exit-IP detection confirms the real proxy timezone.
    const ip = await IPLoc.getIPLocation(s.ipToken);
    if (!ip || ip.lat == null) throw new Error('All IP geolocation providers failed.');

    const pick = await GeoUtil.chooseResidential(ip.lat, ip.lon, {
      radius: 2500, limit: 150, timeoutMs: 12000,
    });
    const addr = await IPLoc.getDisplayAddress(pick.lat, pick.lon);

    const timezone = ip.timezone || null;
    const loc = Locale.localeFor(ip.countryCode, timezone);

    const override = {
      lat: pick.lat, lon: pick.lon, acc: s.accuracyM,
      source: pick.source, road: pick.road || null,
      enabled: s.enabled, ts: now,
      timezone,
      tzEnabled: s.tzEnabled,
      langEnabled: s.langEnabled,
      locale: loc ? loc.language : null,
      languages: loc ? loc.languages : null,
      acceptLanguage: loc ? loc.acceptLanguage : null,
    };
    const state = {
      status: 'ok',
      ip: ip.ip, ipCity: ip.city, ipRegion: ip.region,
      ipCountry: ip.country, ipCountryCode: ip.countryCode,
      ipLat: ip.lat, ipLon: ip.lon, isp: ip.isp, provider: ip.provider,
      ipTimezone: timezone, tzSource: timezone ? 'ip' : 'none',
      ipLocale: loc ? loc.language : null,
      overrideLat: pick.lat, overrideLon: pick.lon,
      overrideSource: pick.source, overrideRoad: pick.road || null,
      overrideAddress: addr ? addr.text : '',
      lastUpdated: now, lastError: null,
    };
    await chrome.storage.local.set({ override, state });

  } catch (e) {
    await patchState({ status: 'error', lastError: String((e && e.message) || e), lastUpdated: now });
  }
}

async function ensureAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, s.refreshMinutes) });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await ensureAlarm();

  await refresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const { state } = await chrome.storage.local.get('state');
  const s = await getSettings();
  const age = state && state.lastUpdated ? Date.now() - state.lastUpdated : Infinity;
  if (!state || age > s.refreshMinutes * 60000) await refresh();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (NotmeGuard.handles(msg)) {
    NotmeGuard.message(msg, sender).then(value => sendResponse({ value }), error => sendResponse({ error: error.message }));
    return true;
  }
  (async () => {
    await legacyCleanup;
    if (msg && msg.type === 'REFRESH') {
      await refresh();
    } else if (msg && msg.type === 'SET_SETTINGS') {
      const next = await saveSettings(msg.patch || {});
      const { override } = await chrome.storage.local.get('override');
      if (override) {
        override.enabled = next.enabled;
        override.acc = next.accuracyM;
        override.tzEnabled = next.tzEnabled;
        override.langEnabled = next.langEnabled;
        await chrome.storage.local.set({ override });
      }

      if (msg.patch && 'refreshMinutes' in msg.patch) await ensureAlarm();
    }
    // Return a fresh snapshot for any message (covers GET_STATE too).
    const { state, override, settings } = await chrome.storage.local.get(['state', 'override', 'settings']);
    sendResponse({ state, override, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  })();
  return true; // keep channel open for async sendResponse
});

self.notmeGuardSettings = getSettings;
self.notmeGuardIdentity = () => IDENTITY_PROFILE;
self.notmePrepareEnvironment = async (network, settings, selection) => {
  let location = null;
  let profile = {};
  if (NotmeEnvironment.needsLocation(selection) && settings.manualTz) {
    profile = buildManualOverride(settings, Date.now(), null).override;
  } else if (NotmeEnvironment.needsLocation(selection) && network.trace && network.status !== 'fail') {
    const stored = await chrome.storage.local.get(['state', 'override']);
    if (stored.state?.status === 'ok' && stored.state.ip === network.trace.ip
      && stored.state.ipCountryCode === network.trace.country && stored.state.ipTimezone) {
      location = { ip: stored.state.ip, countryCode: stored.state.ipCountryCode, timezone: stored.state.ipTimezone,
        city: stored.state.ipCity, lat: stored.state.ipLat, lon: stored.state.ipLon };
    } else location = await IPLoc.getLocationForIP(network.trace.ip, settings.ipToken);
    if (location) {
      const locale = Locale.localeFor(location.countryCode, location.timezone);
      const pick = stored.state?.status === 'ok' && stored.state.ip === network.trace.ip && stored.override?.lat != null
        ? stored.override : selection.enabled
          ? await GeoUtil.chooseResidential(location.lat, location.lon, { radius: 2500, limit: 150, timeoutMs: 12000 })
          : { lat: location.lat, lon: location.lon };
      profile = { lat: pick.lat, lon: pick.lon, timezone: location.timezone,
        locale: locale?.language, languages: locale?.languages, acceptLanguage: locale?.acceptLanguage };
    }
  }
  const checks = NotmeEnvironment.checks(network, location, settings, selection);
  if (selection.langEnabled && !profile.locale) checks.push({ name: '伪装语言', status: 'fail', detail: '无法生成所选环境的语言' });
  if (selection.enabled && profile.lat == null) checks.push({ name: '伪装位置', status: 'fail', detail: '未取得可用的位置坐标' });
  if (selection.webrtcProtect) checks.push({ name: 'WebRTC 保护', status: 'ok',
    detail: '确认后仅在此网站禁用 WebRTC 连接，其他网站保持默认' });
  if (checks.some(check => check.status !== 'ok')) return { checks, override: null };
  const override = {
    ...profile, ...selection, guardSelection: true, acc: settings.accuracyM, ts: Date.now(), identityProfile: IDENTITY_PROFILE,
  };
  return { checks, override };
};
importScripts('lib/guard.js');

async function openEnvironmentPage(tab) {
  const page = chrome.runtime.getURL('gate.html');
  if (tab.url?.startsWith(page)) return;
  const existing = (await chrome.tabs.query({ url: page + '*' })).find(item => item.url === page + '?settings');
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: page + '?settings' });
}
chrome.action.onClicked.addListener(openEnvironmentPage);
