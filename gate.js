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
  return { ...Object.fromEntries(surfaces.map(({ key }) => [key, $(`input[name="${key}"]:checked`)?.value === 'spoof'])),
    geoMode: $('input[name="enabled"]:checked')?.value || 'blocked' };
}
function setSelection(values) {
  for (const { key } of surfaces) {
    const value = key === 'enabled' ? values.geoMode || (values.enabled ? 'spoof' : 'native') : values[key] ? 'spoof' : 'native';
    $(`input[name="${key}"][value="${value}"]`).checked = true;
  }
}
function showMode() {
  const selected = selection();
  const allNative = surfaces.every(({ key }) => !selected[key]) && selected.geoMode === 'native';
  const preset = surfaces.every(({ key }) => selected[key] === defaults[key]) && selected.geoMode === defaults.geoMode;
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
    const choices = key === 'enabled' ? [['blocked', '不提供位置'], ['spoof', '伪装'], ['native', '系统默认']]
      : [['spoof', '伪装'], ['native', '系统默认']];
    for (const [value, caption] of choices) {
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
  if (selected.geoMode === 'blocked') $('#detail-enabled').textContent = '拒绝网站定位请求，不查询住宅坐标';
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
function countryName(code) {
  if (!code) return '地区未确认';
  code = code.toUpperCase();
  if (code === 'CN') return '中国大陆 · CN';
  if (code === 'HK') return '香港 · HK';
  return `${new Intl.DisplayNames('zh-CN', { type: 'region' }).of(code.toUpperCase())} · ${code.toUpperCase()}`;
}
function networkCard(id, title, source, status, badge, exits, fields = [], note = '', empty = '未取得出口 IP') {
  const card = document.createElement('article'); card.id = id; card.className = 'check network-card ' + status;
  const heading = document.createElement('div'); heading.className = 'card-heading';
  const label = document.createElement('b'); label.textContent = title;
  const state = document.createElement('span'); state.className = 'status-badge'; state.textContent = badge;
  heading.append(label, state);
  const origin = document.createElement('p'); origin.className = 'card-source'; origin.textContent = source;
  card.append(heading, origin);
  const unique = [...new Map(exits.map(exit => [`${exit.ip}/${exit.country}/${exit.protocol}`, exit])).values()];
  if (!unique.length) {
    const placeholder = document.createElement('p'); placeholder.className = 'exit-placeholder'; placeholder.textContent = empty; card.append(placeholder);
  }
  for (const exit of unique) {
    const row = document.createElement('div'); row.className = 'endpoint';
    const ip = document.createElement('strong'); ip.className = 'exit-ip'; ip.textContent = exit.ip;
    const region = document.createElement('span'); region.className = 'endpoint-meta'; region.textContent = countryName(exit.country);
    const protocol = document.createElement('span'); protocol.className = 'protocol'; protocol.textContent = exit.protocol?.toUpperCase() || '协议未知';
    row.append(ip, region, protocol); card.append(row);
  }
  if (fields.length) {
    const facts = document.createElement('dl'); facts.className = 'network-fields';
    for (const [name, value] of fields) {
      const field = document.createElement('div'); const term = document.createElement('dt'); term.textContent = name;
      const fact = document.createElement('dd'); fact.textContent = value; field.append(term, fact); facts.append(field);
    }
    card.append(facts);
  }
  if (note) { const detail = document.createElement('p'); detail.className = 'card-note'; detail.textContent = note; card.append(detail); }
  return card;
}
function renderNetwork(view) {
  const report = view.report || {};
  const changed = report.exitRecord?.changed;
  $('#exit-alert').hidden = !changed;
  if (changed) {
    $('#exit-alert-host').textContent = report.host;
    $('#exit-alert-before').textContent = report.exitRecord.previous.ip;
    $('#exit-alert-after').textContent = report.exitRecord.current.ip;
  }
  const probes = report.probes || [];
  const reachable = probes.filter(probe => probe.reachable);
  const average = reachable.length ? Math.round(reachable.reduce((sum, probe) => sum + probe.durationMs, 0) / reachable.length) : null;
  const connection = report.checks?.find(check => check.name === 'HTTP 连通性');
  const targetExits = probes.flatMap(probe => probe.trace ? [probe.trace] : []);
  const host = report.host || new URL(view.target).hostname;
  const targetStatus = report.traceSource ? 'info' : report.networkStatus === 'fail' ? 'fail' : connection?.status || 'info';
  const target = networkCard('target-network', report.traceSource ? '检测站连接' : '目标站出口', host, targetStatus,
    report.traceSource ? '待确认' : targetStatus === 'fail' ? '连接失败' : targetStatus === 'warn' ? '连接提示' : report.trace ? '已获取' : '未验证',
    targetExits, probes.length ? [['平均延迟', average === null ? '—' : average + ' ms'], ['响应', `${reachable.length}/${probes.length}`],
      ['HTTP 状态', [...new Set(reachable.map(probe => probe.status))].join(' / ') || '—']] : [],
    host !== new URL(view.target).hostname ? '检测 Claude 网络出口；确认后进入原检测站。' : connection?.blocking ? connection.detail : '',
    report.traceSource ? '确认后连接' : '未取得出口 IP');
  if (report.exitRecord) {
    const { previous, changed } = report.exitRecord;
    const record = document.createElement('p');
    record.className = changed ? 'exit-change' : 'card-note';
    record.textContent = previous
      ? (changed ? '出口 IP 已变化：' : '出口 IP 与上次相同：') + previous.ip
        + (changed ? ' → ' + report.exitRecord.current.ip : '')
        + '（上次：' + new Date(previous.checkedAt).toLocaleString() + '）'
      : '首次记录此域名的出口 IP。';
    target.append(record);
    const history = document.createElement('details'); history.className = 'exit-history';
    const heading = document.createElement('summary');
    heading.textContent = '最近 ' + report.exitRecord.history.length + ' 次记录'; history.append(heading);
    const list = document.createElement('ol');
    for (const item of report.exitRecord.history) {
      const row = document.createElement('li');
      const address = document.createElement('b'); address.textContent = item.ip;
      const time = document.createElement('time'); time.dateTime = new Date(item.checkedAt).toISOString();
      time.textContent = new Date(item.checkedAt).toLocaleString();
      row.append(address, time); list.append(row);
    }
    history.append(list); target.append(history);
  }
  const thirdParty = report.thirdPartyHTTP3 || {};
  const cloudflareTrace = thirdParty.trace;
  const cloudflareCheck = report.checks?.find(check => check.name === 'HTTP/3 / QUIC（第三方参考）');
  const matches = cloudflareTrace && report.trace && cloudflareTrace.ip === report.trace.ip && cloudflareTrace.country === report.trace.country;
  const comparison = cloudflareTrace && report.trace ? `与${report.traceSource ? '参考' : '目标站'}出口${matches ? '相同' : '不同'}` : '';
  const cloudflare = networkCard('cloudflare-network', '测试站出口', thirdParty.host, cloudflareCheck?.status || 'info',
    cloudflareTrace?.protocol === 'http/3' ? 'HTTP/3 已验证' : 'HTTP/3 未验证',
    cloudflareTrace ? [cloudflareTrace] : [], [], comparison || thirdParty.error || '');
  const udp = report.udp || {};
  const udpCheck = report.checks?.find(check => check.name === 'UDP / STUN');
  const protectedUDP = udp.state === 'restricted' && udp.policy === 'disable_non_proxied_udp';
  const udpExits = udp.state === 'available' ? (udp.ips || []).map(ip => ({ ip,
    country: udp.regions?.find(region => NotmeUDP.normalizeIP(region.ip) === NotmeUDP.normalizeIP(ip))?.countryCode, protocol: 'UDP' })) : [];
  const udpMatches = report.trace && udpExits.length && udpExits.every(exit => NotmeUDP.normalizeIP(exit.ip) === NotmeUDP.normalizeIP(report.trace.ip));
  const stun = networkCard('udp-network', 'UDP / STUN', 'stun.cloudflare.com:3478', udpCheck?.status || 'info',
    protectedUDP ? '已保护' : udpExits.length ? '收到响应' : '未验证', udpExits, [],
    protectedUDP ? '浏览器已限制非代理 UDP，未发送 STUN。' : udpExits.length && report.trace
      ? `与${report.traceSource ? '参考' : '目标站'}出口${udpMatches ? '相同' : '不同'}` : '未取得 STUN 响应。',
    protectedUDP ? 'WebRTC 防泄漏保护已生效' : 'UDP 出口未验证');
  const policy = document.createElement('div'); policy.id = 'network-policy';
  const unknown = [...new Set((report.exits || []).filter(exit => !exit.country).map(exit => exit.ip))].length;
  const noExits = !report.exits?.length;
  policy.className = 'policy-status ' + (report.regionBlocked ? 'fail' : unknown || noExits ? 'info' : 'ok');
  const title = document.createElement('b'); title.textContent = report.regionBlocked ? '检测到中国大陆 / 香港出口，禁止访问'
    : noExits ? '尚未确认出口地区' : unknown ? '未发现受限出口，部分地区尚未确认' : '未发现中国大陆 / 香港出口';
  policy.append(title);
  if (report.regionBlocked) {
    const blocked = document.createElement('p'); blocked.textContent = report.checks?.find(check => check.name === '出口地区检查')?.detail;
    policy.append(blocked);
  }
  $('#checks').replaceChildren(target, cloudflare, stun, policy);
  const failed = report.regionBlocked || report.networkStatus === 'fail';
  $('#network-status').textContent = failed ? '未通过'
    : report.networkStatus === 'warn' ? '连接有提示' : '检查完成';
  $('#network-status').className = 'status-badge ' + (failed ? 'fail' : report.networkStatus === 'warn' ? 'warn' : 'ok');
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
  }, view.report?.traceSource || `目标站 ${view.report?.host || new URL(view.target).hostname} 的 HTTPS 请求出口`);
  renderNetwork(view);
  $('#environment-errors').replaceChildren(...(view.report?.environmentChecks || []).filter(check => check.status === 'fail').map(check => {
    const error = document.createElement('p'); error.textContent = check.detail; return error;
  }));
  const ready = Boolean(view.report?.ready);
  const warnings = view.report?.checks.some(check => check.status === 'warn');
  $('#confirm').disabled = !ready;
  $('#summary').hidden = false;
  $('#summary').textContent = ready ? warnings
    ? '可以访问，网络有提示，请核对上方结果。' : '环境已就绪，点击“确认并访问”进入网站。'
    : '暂时无法访问，请核对网络结果和所选环境。';
  $('#diagnostics').open = true;
}
function renderSettings(snapshot) {
  showChoices(snapshot.override); showInfo(snapshot);
  $('#target').textContent = [snapshot.state?.ipCity, snapshot.override?.timezone, snapshot.override?.locale].filter(Boolean).join(' · ');
  $('#summary').hidden = false;
  $('#summary').textContent = ['ok', 'manual'].includes(snapshot.state?.status)
    ? '选择默认环境，点击“保存为默认”生效。打开目标网站时仍会检查并确认。'
    : '自动检测尚未成功，可以刷新环境或选择手动时区。';
}
let progressTimer;
let progressRun = 0;
function startProgress() {
  clearInterval(progressTimer);
  const run = ++progressRun, started = performance.now();
  const box = $('#check-progress'), track = $('#progress-track');
  box.hidden = false; box.dataset.running = 'true'; box.dataset.warning = 'false';
  track.removeAttribute('aria-valuenow');
  const elapsed = () => { $('#progress-time').textContent = ((performance.now() - started) / 1000).toFixed(1) + ' 秒'; };
  elapsed(); progressTimer = setInterval(elapsed, 100);
  const step = (index, label) => {
    if (run !== progressRun) return;
    $('#progress-label').textContent = label; track.setAttribute('aria-valuetext', label);
    $('#progress-fill').style.width = [12, 45, 78, 100][index] + '%';
    document.querySelectorAll('.progress-steps li').forEach((item, i) => { item.className = i < index ? 'done' : i === index ? 'active' : ''; });
  };
  step(0, '正在准备环境');
  return { step, finish(label, warning = false) {
    if (run !== progressRun) return;
    clearInterval(progressTimer); elapsed(); step(3, label);
    box.dataset.running = 'false'; box.dataset.warning = String(warning);
  } };
}
async function check() {
  const current = ++revision;
  $('#exit-alert').hidden = true;
  busy = true; $('#confirm').disabled = true; $('#retry').disabled = true; $('#error').textContent = '';
  showChoices(); $('#summary').hidden = true;
  if (!settingsOnly) {
    $('#network-status').textContent = '正在检查'; $('#network-status').className = 'status-badge info';
    $('#network-elapsed').textContent = '';
    $('#checks').replaceChildren(); $('#environment-errors').replaceChildren();
  }
  const started = performance.now();
  const progress = startProgress();
  const chosen = selection();
  try {
    await preferencesTask;
    if (current !== revision) return;
    if (settingsOnly) {
      const snapshot = await api({ type: 'GET_STATE' });
      if (current === revision) { renderSettings(snapshot); progress.finish('环境已读取'); }
      return;
    }
    const policy = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    progress.step(1, '正在检测 HTTPS、HTTP/3 与 UDP');
    const [view, udp] = await Promise.all([
      send('CHECK', { selection: chosen }), NotmeUDP.probe({ policy: policy.value }),
    ]);
    if (current !== revision) return;
    progress.step(2, '正在核实出口地区');
    const updated = await send('UDP', { navigationId: view.navigationId, checkId: view.report.id, selection: chosen, udp });
    if (current === revision) {
      render(updated);
      progress.finish(updated.report.ready ? '检查完成，可以确认访问' : '检查完成，请查看提示', !updated.report.ready);
      $('#network-elapsed').textContent = `用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
    }
  }
  catch (error) { if (current === revision) { $('#error').textContent = error.message; progress.finish('检查未完成，请重试', true); } }
  finally { if (current === revision) { busy = false; $('#retry').disabled = false; } }
}
async function updatePreference(patch, refresh = false) {
  clearInterval(progressTimer); ++progressRun; $('#check-progress').hidden = true;
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
  $('#error').textContent = '';
  busy = true; $('#confirm').disabled = true; $('#confirm').textContent = '正在进入…';
  let progress;
  const controls = document.querySelectorAll('#choices input, #choices select, #advanced input, .presets button, #save-defaults, #retry');
  for (const input of controls) input.disabled = true;
  try {
    const chosen = selection();
    let destination = await send('CONFIRM', { navigationId, selection: chosen });
    if (destination?.recheck) {
      $('#confirm').textContent = '正在复查…';
      progress = startProgress(); progress.step(1, '正在重新检测网络');
      const policy = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
      const [token, udp] = await Promise.all([
        send('PREPARE_CONFIRM', { navigationId, selection: chosen }),
        NotmeUDP.probe({ policy: policy.value }),
      ]);
      $('#confirm').textContent = '正在确认出口…';
      progress.step(2, '正在核实出口地区');
      destination = await send('CONFIRM', { navigationId, selection: chosen, udp, token });
    }
    progress?.finish('检查完成，正在进入');
    location.replace(destination);
  }
  catch (error) {
    const view = await send('STATE');
    if (view?.report) render(view);
    progress?.finish('暂时无法进入，请查看提示', true);
    $('#error').textContent = error.message; busy = false; $('#confirm').textContent = '确认并访问';
    for (const input of controls) input.disabled = false;
  }
};
$('#close').onclick = () => chrome.tabs.remove(tabId);
(async () => {
  if (location.hash.startsWith('#redirect=')) history.replaceState(null, '', '#target=' + encodeURIComponent(location.hash.slice('#redirect='.length)));
  tabId = (await chrome.tabs.getCurrent()).id;
  let view;
  if (!settingsOnly) {
    for (let i = 0; i < 20; i++) { view = await send('STATE', { target: new URLSearchParams(location.hash.slice(1)).get('target') }); if (view) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    if (view?.target) history.replaceState(null, '', '#target=' + encodeURIComponent(view.target));
    if (!view) throw new Error('原访问地址未保存，无法恢复。请从浏览器历史记录重新打开原页面。');
    if (view.phase === 'checking') {
      const destination = await send('REUSE');
      if (destination) { location.replace(destination); return; }
    }
    settingsOnly = view.phase !== 'checking';
  }
  const snapshot = await api({ type: 'GET_STATE' }); settings = snapshot.settings; globalSnapshot = snapshot;
  defaults = NotmeEnvironment.defaultSelection({ ...settings, enabled: true, webrtcProtect: true, guardDefaults: null });
  buildChoices(); bindPreferences(); showInfo(snapshot);
  setSelection(view?.defaults || NotmeEnvironment.defaultSelection(settings));
  for (const button of document.querySelectorAll('.presets button, #save-defaults')) button.disabled = false;
  if (settingsOnly) {
    $('#heading').textContent = '设置默认环境。'; $('#eyebrow').textContent = '与访问前的环境选择使用同一页面';
    $('#confirm').hidden = true; $('#diagnostics').hidden = true; $('#retry').textContent = '刷新环境';
    $('#scope').textContent = '保存为默认只用于 Anthropic / Claude 和两个检测站下次访问的预选；每次访问都可重新选择并确认。';
  } else $('#target').textContent = view.target;
  await check();
})().catch(error => { $('#error').textContent = error.message; });
