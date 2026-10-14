let tabId;
let navigationId;
let defaults;
let settings;
let globalSnapshot;
let settingsOnly = new URLSearchParams(location.search).has('settings');
let busy = false;
let revision = 0;
let preferencesTask = Promise.resolve();
const $ = selector => document.querySelector(selector);
const surfaces = NotmeEnvironment.SURFACES;
const native = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language };
function selection() {
  return Object.fromEntries(surfaces.map(({ key }) => [key, $(`input[name="${key}"]:checked`)?.value === 'spoof']));
}
function setSelection(values) {
  for (const { key } of surfaces) $(`input[name="${key}"][value="${values[key] ? 'spoof' : 'native'}"]`).checked = true;
}
function showMode() {
  const selected = selection();
  const allNative = Object.values(selected).every(value => !value);
  const preset = surfaces.every(({ key }) => selected[key] === defaults[key]);
  $('#preset-spoof').setAttribute('aria-pressed', preset);
  $('#preset-native').setAttribute('aria-pressed', allNative);
  $('#mode').textContent = allNative ? '系统默认' : preset ? 'notme 伪装' : '自定义组合';
}
function buildChoices() {
  $('#choices').replaceChildren(...surfaces.map(({ key, label, note }) => {
    const row = document.createElement('div'); row.className = 'choice';
    const text = document.createElement('div');
    const title = document.createElement('b'); title.textContent = label;
    const detail = document.createElement('p'); detail.id = `detail-${key}`;
    text.append(title, detail);
    if (key === 'tzEnabled') {
      const field = document.createElement('label'); field.className = 'timezone-setting'; field.id = 'timezone-setting';
      field.textContent = '伪装地区 / 时区';
      const select = document.createElement('select'); select.id = 'manualTz';
      select.add(new Option('自动：跟随出口 IP', ''));
      const regions = new Intl.DisplayNames('zh-CN', { type: 'region' });
      for (const zone of TZData.TZ_ORDER) {
        const name = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, timeZoneName: 'long' })
          .formatToParts().find(part => part.type === 'timeZoneName').value;
        select.add(new Option(`${regions.of(TZData.TZ_PROFILES[zone].cc)} · ${name} (${zone})`, zone));
      }
      if (settings.manualTz && !TZData.TZ_ORDER.includes(settings.manualTz)) select.add(new Option(settings.manualTz, settings.manualTz));
      select.value = settings.manualTz;
      select.onchange = () => updatePreference({ manualTz: select.value }, true);
      field.append(select); text.append(field);
    }
    if (note) { const small = document.createElement('small'); small.textContent = note; text.append(small); }
    const group = document.createElement('div'); group.className = 'switch-options';
    for (const [value, caption] of [['spoof', '伪装'], ['native', '系统默认']]) {
      const option = document.createElement('label');
      const input = document.createElement('input'); input.type = 'radio'; input.name = key; input.value = value;
      input.setAttribute('aria-label', `${label}：${caption}`); input.onchange = () => { $('#saved').textContent = ''; check(); };
      const span = document.createElement('span'); span.textContent = caption;
      option.append(input, span); group.append(option);
    }
    row.append(text, group); return row;
  }));
}
function showChoices(profile) {
  const selected = selection();
  const original = {
    enabled: '使用系统定位与浏览器位置权限', tzEnabled: native.timezone, langEnabled: native.language,
    identityEnabled: '使用浏览器原本的设备信息', fontEnabled: '使用系统字体',
    workerEnabled: '使用原生后台脚本环境', webrtcProtect: '使用浏览器默认策略',
  };
  const spoofed = {
    enabled: '使用伪装地区附近的位置',
    tzEnabled: profile?.timezone || settings.manualTz || '跟随出口 IP', langEnabled: profile?.locale || '跟随伪装地区',
    identityEnabled: '显示 Chrome，隐藏设备型号', fontEnabled: '隐藏可用于识别地区的中文字体',
    workerEnabled: '后台脚本也使用所选时区与语言', webrtcProtect: '禁用本站的 WebRTC 连接',
  };
  for (const { key } of surfaces) $(`#detail-${key}`).textContent = selected[key] ? spoofed[key] : original[key];
  $('#timezone-setting').hidden = !selected.tzEnabled;
  showMode();
}
async function api(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response.error) throw new Error(response.error);
  return response;
}
async function send(type, extra = {}) {
  return (await api({ type: 'NOTME_GUARD_' + type, tabId, ...extra })).value;
}
function showInfo(snapshot, exitSource) {
  const state = snapshot.state || {};
  const profile = snapshot.override || {};
  const source = { overpass: '附近住宅街道', jitter: '附近位置偏移', ipcenter: '出口位置' };
  const values = {
    '出口 IP': state.ip, '出口地区': [state.ipCity, state.ipRegion, state.ipCountry].filter(Boolean).join(' · '),
    '出口来源': exitSource || `第三方查 IP 服务（${state.provider || '地理查询服务'}）；不代表 Anthropic，可能因分流而不同`,
    '网络服务商': state.isp, '伪装地址': state.overrideAddress,
    '位置来源': source[state.overrideSource],
    '更新时间': state.lastUpdated && new Date(state.lastUpdated).toLocaleString('zh-CN'),
  };
  if (profile.lat != null) values['伪装坐标'] = `${profile.lat.toFixed(5)}, ${profile.lon.toFixed(5)}`;
  $('#environment-info').replaceChildren(...Object.entries(values).flatMap(([label, value]) => {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = value || '—';
    return [term, detail];
  }));
}
function render(view) {
  navigationId = view.navigationId;
  $('#target').textContent = view.target;
  showChoices(view.override);
  const trace = view.report?.trace;
  showInfo({
    state: { ...(trace?.ip === globalSnapshot.state?.ip ? globalSnapshot.state : {}),
      ip: trace?.ip, ipCountry: trace?.country, lastUpdated: view.report?.checkedAt,
      overrideAddress: view.override?.enabled && view.override.lat === globalSnapshot.override?.lat
        ? globalSnapshot.state?.overrideAddress : null },
    override: view.override?.enabled ? view.override : null,
  }, `目标站 ${new URL(view.target).hostname} 的 HTTPS 请求出口`);
  $('#checks').replaceChildren(...(view.report?.checks || []).map(check => {
    const row = document.createElement('div'); row.className = 'check ' + check.status;
    const icon = document.createElement('span'); icon.textContent = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : check.status === 'info' ? 'i' : '×';
    const text = document.createElement('div');
    const label = document.createElement('b'); label.textContent = check.name;
    const detail = document.createElement('p'); detail.textContent = check.detail;
    text.append(label, detail); row.append(icon, text); return row;
  }));
  const ready = Boolean(view.report?.ready);
  const warnings = view.report?.checks.some(check => check.status === 'warn');
  $('#confirm').disabled = !ready;
  $('#summary').textContent = ready ? warnings
    ? '可以访问；网络诊断有提示，请展开详情核对。' : '检查通过。确认后即可访问。'
    : '检查未通过，暂时不能访问。请查看下方原因后重试。';
  $('#check-summary').textContent = `${ready ? warnings ? '网络诊断有提示' : '网络检查通过' : '网络检查未通过'} · HTTPS / UDP / HTTP/3`;
  if (!ready || warnings) $('#diagnostics').open = true;
}
function renderSettings(snapshot) {
  showChoices(snapshot.override); showInfo(snapshot);
  $('#target').textContent = [snapshot.state?.ipCity, snapshot.override?.timezone, snapshot.override?.locale].filter(Boolean).join(' · ');
  $('#summary').textContent = ['ok', 'manual'].includes(snapshot.state?.status)
    ? '选择默认环境，点击“保存为默认”生效。打开目标网站时仍会检查并确认。'
    : '自动检测尚未成功，可以刷新环境或选择手动时区。';
}
async function check() {
  const current = ++revision;
  busy = true; $('#confirm').disabled = true; $('#retry').disabled = true; $('#error').textContent = '';
  showChoices(); $('#summary').textContent = settingsOnly ? '正在读取环境…' : '正在检查网络与所选环境…';
  const chosen = selection();
  try {
    await preferencesTask;
    if (current !== revision) return;
    if (settingsOnly) {
      const snapshot = await api({ type: 'GET_STATE' });
      if (current === revision) renderSettings(snapshot);
      return;
    }
    const policy = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    const [view, udp] = await Promise.all([
      send('CHECK', { selection: chosen }), NotmeUDP.probe({ policy: policy.value }),
    ]);
    if (current !== revision) return;
    const updated = await send('UDP', { navigationId: view.navigationId, checkId: view.report.id, selection: chosen, udp });
    if (current === revision) render(updated);
  }
  catch (error) { if (current === revision) $('#error').textContent = error.message; }
  finally { if (current === revision) { busy = false; $('#retry').disabled = false; } }
}
async function updatePreference(patch, refresh = false) {
  ++revision; $('#confirm').disabled = true; $('#retry').disabled = true; $('#error').textContent = '';
  preferencesTask = preferencesTask.then(async () => {
    const snapshot = await api({ type: 'SET_SETTINGS', patch }); settings = snapshot.settings; globalSnapshot = snapshot;
    showInfo(snapshot);
    if (refresh) { globalSnapshot = await api({ type: 'REFRESH' }); showInfo(globalSnapshot); }
  });
  try {
    await preferencesTask;
    $('#saved').textContent = '设置已保存。';
    await check();
  } catch (error) {
    $('#error').textContent = error.message; preferencesTask = Promise.resolve(); busy = false; $('#retry').disabled = false;
  }
}
function bindPreferences() {
  for (const key of ['accuracyM', 'refreshMinutes', 'networkWarnMs', 'ipToken']) {
    const input = $('#' + key); input.value = settings[key];
    input.onchange = () => {
      if (!input.reportValidity()) return;
      const value = input.type === 'number' ? Number(input.value) : input.value.trim();
      if (input.type === 'number' && (!input.value || !Number.isFinite(value))) { input.value = settings[key]; return; }
      updatePreference({ [key]: value });
    };
  }
}
$('#retry').onclick = () => settingsOnly ? updatePreference({}, true) : check();
$('#preset-spoof').onclick = () => { setSelection(defaults); $('#saved').textContent = ''; check(); };
$('#preset-native').onclick = () => { setSelection(Object.fromEntries(surfaces.map(({ key }) => [key, false]))); $('#saved').textContent = ''; check(); };
$('#save-defaults').onclick = async () => {
  const chosen = selection();
  $('#save-defaults').disabled = true;
  await updatePreference({ guardDefaults: chosen });
  if (!$('#error').textContent) $('#saved').textContent = '已保存默认环境；之后打开网站会预选这套开关，仍需检查并确认。';
  $('#save-defaults').disabled = false;
};
$('#confirm').onclick = async () => {
  if (busy || settingsOnly) return;
  busy = true; $('#confirm').disabled = true;
  const controls = document.querySelectorAll('#choices input, #choices select, #advanced input, .presets button, #save-defaults, #retry');
  for (const input of controls) input.disabled = true;
  try {
    const policy = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    const udp = await NotmeUDP.probe({ policy: policy.value });
    const destination = await send('CONFIRM', { navigationId, selection: selection(), udp }); location.replace(destination);
  }
  catch (error) {
    const view = await send('STATE');
    if (view?.report) render(view);
    $('#error').textContent = error.message; busy = false;
    for (const input of controls) input.disabled = false;
  }
};
$('#close').onclick = () => chrome.tabs.remove(tabId);
(async () => {
  tabId = (await chrome.tabs.getCurrent()).id;
  let view;
  if (!settingsOnly) {
    for (let i = 0; i < 20; i++) { view = await send('STATE'); if (view) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    settingsOnly = !view || view.phase !== 'checking';
  }
  const snapshot = await api({ type: 'GET_STATE' }); settings = snapshot.settings; globalSnapshot = snapshot;
  defaults = NotmeEnvironment.defaultSelection({ ...settings, enabled: true, webrtcProtect: true, guardDefaults: null });
  buildChoices(); bindPreferences(); showInfo(snapshot);
  setSelection(view?.defaults || NotmeEnvironment.defaultSelection(settings));
  for (const button of document.querySelectorAll('.presets button, #save-defaults')) button.disabled = false;
  if (settingsOnly) {
    $('#heading').textContent = '设置默认环境。'; $('#eyebrow').textContent = '与访问前的环境选择使用同一页面';
    $('#confirm').hidden = true; $('#diagnostics').hidden = true; $('#retry').textContent = '刷新环境';
    $('#scope').textContent = '保存后仅用于下一次 Anthropic / Claude 访问，其他网站保持系统默认。';
  } else $('#target').textContent = view.target;
  await check();
})().catch(error => { $('#error').textContent = error.message; });
