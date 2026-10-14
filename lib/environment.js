/* notme — choices and validation for one navigation. */
(function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : globalThis;
  const SURFACES = [
    { key: 'enabled', label: '地理位置' },
    { key: 'tzEnabled', label: '时区' },
    { key: 'langEnabled', label: '语言与请求头' },
    { key: 'identityEnabled', label: '浏览器与设备标识' },
    { key: 'fontEnabled', label: '字体' },
    { key: 'workerEnabled', label: '后台脚本（Web Worker）', note: '实验功能，默认关闭；开启后使用所选时区与语言' },
    { key: 'webrtcProtect', label: 'IP 防泄漏（WebRTC）', note: '仅本站；禁用 WebRTC 连接，会影响依赖它的音视频功能' },
  ];

  function defaultSelection(settings) {
    const defaults = { enabled: settings.enabled !== false, tzEnabled: true, langEnabled: true,
      identityEnabled: true, fontEnabled: true, workerEnabled: settings.workerEnabled === true,
      webrtcProtect: settings.webrtcProtect !== false };
    return Object.fromEntries(SURFACES.map(({ key }) => [key,
      typeof settings.guardDefaults?.[key] === 'boolean' ? settings.guardDefaults[key] : defaults[key]]));
  }

  function normalizeSelection(selection, settings) {
    const defaults = defaultSelection(settings);
    return Object.fromEntries(SURFACES.map(({ key }) => [key,
      typeof selection?.[key] === 'boolean' ? selection[key] : defaults[key]]));
  }

  function needsLocation(selection) {
    return selection.enabled || selection.tzEnabled || selection.langEnabled;
  }

  function checks(report, location, settings, selection) {
    if (!needsLocation(selection)) return [];
    if (settings.manualTz) {
      let valid = false;
      try { new Intl.DateTimeFormat('en', { timeZone: settings.manualTz }); valid = true; } catch (_) {}
      return [{ name: 'notme 手动环境', status: valid ? 'ok' : 'fail',
        detail: valid ? `沿用 ${settings.manualTz} 的时区、语言和代表位置` : '手动时区无效，请调整 notme 设置' }];
    }
    const matchingExit = Boolean(report.trace && location && location.ip === report.trace.ip
      && location.countryCode?.toUpperCase() === report.trace.country);
    const result = [{ name: '出口位置', status: matchingExit ? 'ok' : 'fail',
      detail: matchingExit ? `${location.city || ''} · ${location.countryCode}` : '无法核实目标出口 IP 的位置，或地理服务与目标站地区不一致' }];
    if (selection.tzEnabled) {
      let valid = false;
      try { if (location?.timezone) { new Intl.DateTimeFormat('en', { timeZone: location.timezone }); valid = true; } } catch (_) {}
      result.push({ name: '伪装时区', status: valid ? 'ok' : 'fail', detail: valid ? location.timezone : '未取得有效的出口时区' });
    }
    return result;
  }

  function ready(report, environmentChecks) {
    return report.status === 'ok' && environmentChecks.every(check => check.status === 'ok');
  }

  function settingsFingerprint(settings) {
    return JSON.stringify(['accuracyM', 'networkWarnMs', 'manualTz'].map(key => settings[key]));
  }

  const api = { SURFACES, defaultSelection, normalizeSelection, needsLocation, checks, ready, settingsFingerprint };
  root.NotmeEnvironment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
