const tabId = Number(new URLSearchParams(location.search).get('tab'));
const $ = selector => document.querySelector(selector);
let review;
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
  try {
    await send('ALLOW_REQUESTS', {reviewId: review.id, destinations: review.destinations});
    $('#result').textContent = '已临时允许。请返回原页面，重新点击继续或重试；不要刷新页面。';
    $('#close').textContent = '关闭审核页';
  } catch (error) { $('#error').textContent = error.message; }
};
(async () => {
  review = await send('REVIEW');
  if (!review) throw new Error('没有待审核的请求，或原页面已离开。');
  $('#source').textContent = '来源网站：' + review.source;
  $('#destinations').replaceChildren(...review.destinations.map(host => { const item = document.createElement('li'); item.textContent = host; return item; }));
  $('#allow').disabled = false;
})().catch(error => { $('#error').textContent = error.message; });
