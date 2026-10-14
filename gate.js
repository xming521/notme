let tabId;
let navigationId;
let defaults;
let busy = false;
let revision = 0;
const $ = selector => document.querySelector(selector);
const surfaces = NotmeEnvironment.SURFACES;
const native = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, ua: navigator.userAgent };
function selection() {
  return Object.fromEntries(surfaces.map(({ key }) => [key, $(`input[name="${key}"]:checked`)?.value === 'spoof']));
}
function setSelection(values) {
  for (const { key } of surfaces) $(`input[name="${key}"][value="${values[key] ? 'spoof' : 'native'}"]`).checked = true;
}
function showMode() {
  const selected = selection();
  const allNative = Object.values(selected).every(value => !value);
  const preset = JSON.stringify(selected) === JSON.stringify(defaults);
  $('#preset-spoof').setAttribute('aria-pressed', preset);
  $('#preset-native').setAttribute('aria-pressed', allNative);
  $('#mode').textContent = allNative ? '系统默认' : preset ? 'notme 原有流程' : '自定义组合';
}
function buildChoices() {
  $('#choices').replaceChildren(...surfaces.map(({ key, label, note }) => {
    const row = document.createElement('div'); row.className = 'choice';
    const text = document.createElement('div');
    const title = document.createElement('b'); title.textContent = label;
    const detail = document.createElement('p'); detail.id = `detail-${key}`;
    text.append(title, detail);
    if (note) { const small = document.createElement('small'); small.textContent = note; text.append(small); }
    const group = document.createElement('div'); group.className = 'switch-options';
    for (const [value, caption] of [['spoof', '伪装'], ['native', '系统默认']]) {
      const option = document.createElement('label');
      const input = document.createElement('input'); input.type = 'radio'; input.name = key; input.value = value;
      input.setAttribute('aria-label', `${label}：${caption}`); input.onchange = check;
      const span = document.createElement('span'); span.textContent = caption;
      option.append(input, span); group.append(option);
    }
    row.append(text, group); return row;
  }));
}
function showChoices(profile) {
  const selected = selection();
  const original = {
    enabled: '系统定位与浏览器位置权限', tzEnabled: native.timezone, langEnabled: native.language,
    identityEnabled: native.ua, fontEnabled: '系统字体', workerEnabled: '原生 Web Worker', webrtcProtect: '还原浏览器默认策略',
  };
  const spoofed = {
    enabled: profile?.lat == null ? '按 notme 流程生成位置' : `${profile.lat.toFixed(5)}, ${profile.lon.toFixed(5)}`,
    tzEnabled: profile?.timezone || '按 notme 设置生成时区', langEnabled: profile?.locale || '按 notme 设置生成语言',
    identityEnabled: 'Chrome / Chromium，隐藏设备型号', fontEnabled: '隐藏可用于识别地区的中文字体',
    workerEnabled: '将所选时区与语言应用到支持的 Worker', webrtcProtect: '禁止绕过代理的 UDP 连接',
  };
  for (const { key } of surfaces) $(`#detail-${key}`).textContent = selected[key] ? spoofed[key] : original[key];
  showMode();
}
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'NOTME_GUARD_' + type, tabId, ...extra });
  if (response.error) throw new Error(response.error);
  return response.value;
}
function render(view) {
  navigationId = view.navigationId;
  $('#target').textContent = view.target;
  showChoices(view.override);
  $('#checks').replaceChildren(...(view.report?.checks || []).map(check => {
    const row = document.createElement('div'); row.className = 'check ' + check.status;
    const icon = document.createElement('span'); icon.textContent = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×';
    const text = document.createElement('div');
    const label = document.createElement('b'); label.textContent = check.name;
    const detail = document.createElement('p'); detail.textContent = check.detail;
    text.append(label, detail); row.append(icon, text); return row;
  }));
  $('#confirm').disabled = !view.report?.ready;
  $('#summary').textContent = view.report?.ready ? '检查通过。请核对本次选择，然后确认访问。' : '检查未通过。正式网页仍被拦截，请处理问题后重试。';
}
async function check() {
  const current = ++revision;
  busy = true; $('#confirm').disabled = true; $('#retry').disabled = true; $('#error').textContent = '';
  showChoices(); $('#summary').textContent = '正在检查网络与所选环境…';
  try { const view = await send('CHECK', { selection: selection() }); if (current === revision) render(view); }
  catch (error) { if (current === revision) $('#error').textContent = error.message; }
  finally { if (current === revision) { busy = false; $('#retry').disabled = false; } }
}
$('#retry').onclick = check;
$('#preset-spoof').onclick = () => { setSelection(defaults); check(); };
$('#preset-native').onclick = () => { setSelection(Object.fromEntries(surfaces.map(({ key }) => [key, false]))); check(); };
$('#confirm').onclick = async () => {
  if (busy) return;
  busy = true; $('#confirm').disabled = true;
  for (const input of document.querySelectorAll('#choices input, .presets button')) input.disabled = true;
  try { const destination = await send('CONFIRM', { navigationId, selection: selection() }); location.replace(destination); }
  catch (error) {
    $('#error').textContent = error.message; busy = false;
    for (const input of document.querySelectorAll('#choices input, .presets button')) input.disabled = false;
  }
};
$('#settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
$('#close').onclick = () => chrome.tabs.remove(tabId);
(async () => {
  tabId = (await chrome.tabs.getCurrent()).id;
  let view;
  for (let i = 0; i < 20; i++) { view = await send('STATE'); if (view) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  if (!view) throw new Error('未取得待访问的网址，请从地址栏重新打开目标网站');
  defaults = view.defaults;
  buildChoices(); setSelection(defaults);
  for (const button of document.querySelectorAll('.presets button')) button.disabled = false;
  $('#target').textContent = view.target;
  await check();
})().catch(error => { $('#error').textContent = error.message; });
