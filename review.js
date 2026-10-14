const tabId = Number(new URLSearchParams(location.search).get('tab'));
const $ = selector => document.querySelector(selector);
let review;
let checked;
let revision = 0;
async function send(type, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'NOTME_GUARD_' + type, tabId, ...extra });
  if (!reply || reply.error) throw new Error(reply?.error || '请求审核失败');
  return reply.value;
}
$('#close').onclick = () => window.close();
$('#back').onclick = async () => {
  try { const tab = await chrome.tabs.update(tabId, {active: true}); await chrome.windows.update(tab.windowId, {focused: true}); }
  catch (_) { $('#error').textContent = '原标签页已关闭。'; }
};
$('#allow').onclick = async () => {
  $('#allow').disabled = true; $('#error').textContent = '';
  for (const id of ['language','identity','retry']) $('#'+id).disabled = true;
  try {
    if (($('#language').checked || $('#identity').checked) && !await chrome.permissions.request({origins: [review.origin]})) throw new Error('未授予来源网站权限，请求仍保持拦截');
    await send('ALLOW_REQUESTS', {reviewId: review.id, token: checked.token});
    $('#result').textContent = '已临时允许。请返回原页面，重新点击继续或重试；不要刷新页面。';
    $('#close').textContent = '关闭审核页';
  } catch (error) { $('#error').textContent = error.message; }
  finally { for (const id of ['language','identity','retry']) $('#'+id).disabled = false; }
};
(async () => {
  review = await send('REVIEW');
  if (!review) throw new Error('没有待审核的请求，或原页面已离开。');
  $('#source').textContent = '来源网站：' + review.source;
  $('#destinations').replaceChildren(...review.destinations.map(host => { const item = document.createElement('li'); item.textContent = host; return item; }));
  await check();
})().catch(error => { $('#error').textContent = error.message; });

async function check() {
  const run = ++revision;
  checked = null; $('#allow').disabled = true; $('#error').textContent = ''; $('#result').textContent = '';
  $('#status').textContent = '正在检查目标出口与请求头环境…';
  const langEnabled = $('#language').checked, identityEnabled = $('#identity').checked;
  try {
    const policy = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    const udp = await NotmeUDP.probe({policy: policy.value});
    const result = await send('CHECK_REQUESTS', {reviewId: review.id, destinations: review.destinations, langEnabled, identityEnabled, udp});
    if (run !== revision) return;
    checked = result;
    $('#status').textContent = result.results.map(item => item.host + ' · ' + (item.ip || '出口未验证') + ' · ' + item.language + ' · ' + item.identity).join('；');
    $('#error').textContent = result.ready ? '' : result.results.flatMap(item => item.errors).join('；') || '检查未通过，不能放行';
    $('#allow').disabled = !result.ready;
  } catch (error) { if (run === revision) { $('#error').textContent = error.message; $('#status').textContent = '检查未完成'; } }
}
$('#retry').onclick = check;
$('#language').onchange = check;
$('#identity').onchange = check;
