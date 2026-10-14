/* notme — publish an admitted tab profile or the saved verification defaults. */
(function () {
  let host = location.hostname || '';
  if (!host) { try { host = new URL(window.origin).hostname; } catch (_) {} }
  const verification = /^(fuck-claude\.vercel\.app|fuck-claude\.app)\.?$/i.test(host);
  if (!verification && !/(^|\.)(anthropic\.com|claude\.ai|claude\.com|claude\.app|claudeusercontent\.com|claudemcpcontent\.com|claude\.site)\.?$/i.test(host)) return;
  const MARK = '__nmb__';
  function publish() {
    chrome.runtime.sendMessage({ type: verification ? 'NOTME_VERIFICATION_PROFILE' : 'NOTME_GUARD_PROFILE' }, response => {
      if (response?.value) window.postMessage({ [MARK]: 'data', payload: response.value }, '*');
    });
  }
  window.addEventListener('message', event => {
    if (event.data?.[MARK] === 'req') publish();
  });
  publish();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.guard) publish();
    if (verification && area === 'local' && (changes.settings || changes.override || changes.identityProfile)) publish();
  });
})();
