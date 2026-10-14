/* Shared browser/device profile for page APIs and outgoing request headers. */
(function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : globalThis;

  function buildProfile(ua, platform, data) {
    ua = String(ua || '');
    platform = String(platform || '');
    data = data || {};
    const chromium = ua.match(/(?:Chrome|Chromium|CriOS)\/(\d+(?:\.\d+){0,3})/i);
    const brand = (data.brands || []).find(b => /^(Chromium|Google Chrome)$/i.test(b.brand || ''));
    const parts = String(chromium ? chromium[1] : (brand ? brand.version : '119')).split('.');
    while (parts.length < 4) parts.push('0');
    const version = parts.slice(0, 4).join('.');
    const major = parts[0];
    const probe = [ua, platform, data.platform || ''].join(' ');
    let os, navPlatform, uaPlatform;
    let mobile = typeof data.mobile === 'boolean' ? data.mobile : /Mobile/i.test(ua);
    if (/Android|HarmonyOS|OpenHarmony/i.test(probe)) {
      os = 'Linux; Android 10; K'; navPlatform = 'Linux armv8l'; uaPlatform = 'Android';
    } else if (/iPhone|iPad|iPod|\biOS\b/i.test(probe)) {
      os = 'iPhone; CPU iPhone OS 17_0 like Mac OS X'; navPlatform = 'iPhone'; uaPlatform = 'iOS';
    } else if (/Windows|Win32|Win64/i.test(probe)) {
      os = 'Windows NT 10.0; Win64; x64'; navPlatform = 'Win32'; uaPlatform = 'Windows'; mobile = false;
    } else if (/Macintosh|MacIntel|macOS/i.test(probe)) {
      os = 'Macintosh; Intel Mac OS X 10_15_7'; navPlatform = 'MacIntel'; uaPlatform = 'macOS'; mobile = false;
    } else if (/CrOS|Chrome OS/i.test(probe)) {
      os = 'X11; CrOS x86_64 14541.0.0'; navPlatform = 'Linux x86_64'; uaPlatform = 'Chrome OS'; mobile = false;
    } else {
      os = 'X11; Linux x86_64'; navPlatform = 'Linux x86_64'; uaPlatform = 'Linux'; mobile = false;
    }
    const userAgent = 'Mozilla/5.0 (' + os + ') AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/' + version + (mobile ? ' Mobile' : '') + ' Safari/537.36';
    return {
      userAgent, appVersion: userAgent.replace(/^Mozilla\//, ''),
      platform: navPlatform, uaPlatform, vendor: 'Google Inc.', mobile, version,
      brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }],
      fullVersionList: [{ brand: 'Chromium', version }, { brand: 'Google Chrome', version }],
    };
  }

  function fromNavigator(nav) {
    let ua = '', platform = '', data = {};
    try { ua = nav.userAgent; platform = nav.platform; } catch (_) {}
    try {
      const native = nav.userAgentData;
      if (native) data = { brands: native.brands, mobile: native.mobile, platform: native.platform };
    } catch (_) {}
    return buildProfile(ua, platform, data);
  }

  function brands(profile, full, frozen) {
    const list = (full ? profile.fullVersionList : profile.brands).map(b => ({ brand: b.brand, version: b.version }));
    return frozen ? Object.freeze(list.map(b => Object.freeze(b))) : list;
  }

  function lowEntropy(profile) {
    return { brands: brands(profile, false, false), mobile: profile.mobile, platform: profile.uaPlatform };
  }

  function highEntropy(profile, nativeValues) {
    const values = { ...nativeValues, ...lowEntropy(profile) };
    // Only replace optional keys the native API actually returned: keep hint
    // validation and Permissions-Policy behavior delegated to the browser.
    if ('model' in values) values.model = '';
    if ('uaFullVersion' in values) values.uaFullVersion = profile.version;
    if ('fullVersionList' in values) values.fullVersionList = brands(profile, true, false);
    return values;
  }

  function requestHeaders(profile) {
    const list = items => items.map(b => JSON.stringify(b.brand) + ';v=' + JSON.stringify(b.version)).join(', ');
    return [
      ['user-agent', profile.userAgent],
      ['sec-ch-ua', list(profile.brands)],
      ['sec-ch-ua-mobile', profile.mobile ? '?1' : '?0'],
      ['sec-ch-ua-platform', JSON.stringify(profile.uaPlatform)],
      ['sec-ch-ua-model', '""'],
      ['sec-ch-ua-full-version', JSON.stringify(profile.version)],
      ['sec-ch-ua-full-version-list', list(profile.fullVersionList)],
    ].map(([header, value]) => ({ header, operation: 'set', value }));
  }

  const api = { buildProfile, fromNavigator, brands, lowEntropy, highEntropy, requestHeaders };
  root.NotmeIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
