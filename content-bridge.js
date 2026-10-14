/* notme — publish only the approved Anthropic tab's profile. */
(function () {
  let host = location.hostname || '';
  if (!host) { try { host = new URL(window.origin).hostname; } catch (_) {} }
  if (!/(^|\.)(anthropic\.com|claude\.ai|claude\.com|claude\.app|claudeusercontent\.com|claudemcpcontent\.com|claude\.site)\.?$/i.test(host)) return;
  const MARK = '__nmb__';
  function publish() {
    chrome.runtime.sendMessage({ type: 'NOTME_GUARD_PROFILE' }, response => {
      if (response?.value) window.postMessage({ [MARK]: 'data', payload: response.value }, '*');
    });
  }
  window.addEventListener('message', event => {
    if (event.data?.[MARK] === 'req') publish();
  });
  publish();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.guard) publish();
  });
})();
