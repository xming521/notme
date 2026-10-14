# notme technical notes

## Purpose

notme aligns the browser-visible profile on selected Anthropic pages with the current proxy/VPN exit IP. It does not change the network IP itself; it changes browser surfaces that otherwise commonly contradict the proxy location.

The extension currently spoofs:

- HTML5 geolocation (`navigator.geolocation`), returning a real `GeolocationPosition`
- geolocation permission query result (a real `PermissionStatus` reporting `granted`)
- the entire `Date` local-time surface in the spoofed IANA zone:
  - `getTimezoneOffset`
  - local getters: `getFullYear`/`getMonth`/`getDate`/`getDay`/`getHours`/`getMinutes`/`getSeconds`/`getMilliseconds`/`getYear`
  - local setters: `setFullYear`/`setMonth`/`setDate`/`setHours`/`setMinutes`/`setSeconds`/`setMilliseconds`/`setYear`
  - `toString`/`toDateString`/`toTimeString`
  - `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`
  - the numeric multi-arg constructor, offset-less `Date.parse` / `new Date(string)`, and `Date()` called as a function
- default `Intl.DateTimeFormat` timezone (injected even when a locale is supplied)
- `navigator.language` and `navigator.languages`
- page `navigator.userAgent`, `appVersion`, `platform`, `vendor`, and UA-CH browser brands/device model, with matching outgoing identity headers
- default locale for `Intl.DateTimeFormat`, `NumberFormat`, `Collator`, `RelativeTimeFormat`, `PluralRules`, `ListFormat`, `DisplayNames`, `Segmenter`, `DurationFormat`
- `Number`/`Array`/`BigInt.prototype.toLocaleString`
- outgoing `Accept-Language` header on all resource types via Chrome `declarativeNetRequest`
- WebRTC connections disabled on selected Anthropic pages and the two verification hosts (optional); other origins retain native WebRTC
- timezone + locale inside dedicated Web Workers (optional; see below)
- CJK font width probing on canvas `measureText` and DOM `getBoundingClientRect`/`getClientRects`/`offsetWidth`/`offsetHeight` (optional; see below)
- `Function.prototype.toString` (so spoofed functions read as native)

## Runtime flow

### Shared environment page

`gate.html` is both the navigation gate and the options page. The toolbar opens
or focuses that same page without a separate popup. Without a pending navigation
it edits defaults and cannot authorize a site visit. Advanced fields save immediately;
changing admission parameters invalidates the displayed check and runs a fresh one.
Check deduplication includes the settings fingerprint to avoid reusing a probe started
with old parameters. `settings.guardDefaults` stores the seven selected defaults;
saving never updates other sites. WebRTC protection is page-local. The all-spoof and all-native
presets remain available even after custom defaults have been saved.

### Anthropic navigation admission

`guard-rules.json` redirects protected main-frame requests to `gate.html` and
blocks protected subresources from extension startup. `lib/network.js` shares
the seven root domains across the worker and profile code. HTTPS trace probes
are the only protected requests allowed from the extension before approval.
Browser APIs do not provide a raw TCP handshake or independent DNS result; the
preflight measures the browser's HTTPS path to the requested hostname.

The trace's `http` field records the protocol of that request. `http=http/3`
confirms HTTP/3/QUIC use; a successful HTTPS response, an `Alt-Svc` header,
HTTP/2 fallback or an absent field does not. Preflight also requests Cloudflare's
QUIC test host, `cloudflare-quic.com/cdn-cgi/trace`, up to three times sequentially
within a shared eight-second timeout, allowing Alt-Svc discovery before retries.
Only a valid trace from that host reporting HTTP/3 is used as the third-party
exit reference. Its IP and country are compared with the target's HTTPS exit. The Cloudflare
card always shows its observed IP and actual protocol, including HTTP/2 fallback;
HTTP/3 verification appears once. The target card keeps the target's own result.
IP-provider observations still enforce region restrictions without a separate UI row.
The target trace remains the input for spoofed geolocation. All valid returned
IPs, including HTTP/2 fallback and earlier retries, participate in the region rule.
An exit difference is informational and can result from split routing.
The extension cannot force `fetch` to use HTTP/3.

`lib/udp.js` runs in the local gate page, where `RTCPeerConnection` is available.
Under `disable_non_proxied_udp`, it returns a restricted result without creating
a peer or modifying privacy settings; the verified policy is displayed as a
passed WebRTC protection check, without claiming an observed UDP exit.
Otherwise it gathers ICE candidates with
Cloudflare's documented [STUN UDP endpoint](https://developers.cloudflare.com/realtime/turn/#service-address-and-ports)
for at most four seconds, alongside the HTTPS checks. Only `udp` / `srflx`
candidates establish a response; local, mDNS, TCP and relay candidates do not.
The peer is closed on completion, error or timeout. Public addresses are
normalized before comparison with the HTTPS exit and looked up using
`IPLoc.getCountryForIP`, which requires neither coordinates nor a timezone.
Different endpoints can have different legitimate routes, so a mismatch is
informational and is not considered a failure.
No response remains unknown. The result reflects the current policy; the chosen
WebRTC setting still applies only on confirmation.

`lib/guard.js` keeps the pending target and profile per tab in session storage.
The gate URL fragment also retains the destination for browser restart recovery;
recovery creates a fresh checking state without restoring admission.
Every main-frame navigation creates a fresh check. Target traces, third-party
test traces, default IP-provider responses, geolocation responses and every
STUN public IP feed `NotmeNetwork.applyExitPolicy`. Only mainland China (`CN`)
and Hong Kong (`HK`) trigger a region ban; a match from any source blocks access.
Observations accumulate for one check, so a later allowed response cannot hide
an earlier restricted one. Unknown regions remain informational. A latency-only
warning does not block access; connectivity and selected-profile data still need
to be usable. `ready` remains false until STUN country lookups finish, and their
results are tied to a check ID to reject stale completions.
Confirmation uses a completed, ready result directly for 15 seconds, with background-worker
validation of its age, navigation, settings and selection. Older results trigger
a fresh check. UDP probing
and HTTPS/HTTP3 rechecks start together. A one-use, tab-bound token transfers
the fresh network result to final confirmation; navigation, report or settings
changes invalidate it. UDP country lookups remain fresh. An allowed
exit change updates the profile rather than failing an equality check. Changed
settings or selections invalidate confirmation. Prepared recheck tokens expire
after 60 seconds and cannot be reused. Proxy route changes within the 15-second
window require a manual check.

Confirmation installs a temporary main-frame allow rule limited to that tab,
host and extension initiator. `onCommitted` removes it. The tab retains a
subresource allow rule and, when needed, a profile header rule until its next navigation.
Main-frame rules and header rules explicitly enumerate resource types: Chrome
excludes main frames when the types are omitted. Header modification priorities
for the per-tab profile are above the allow rules. The header rules match only protected destinations in the admitted tab; other
destinations keep native headers even during navigation away from Anthropic.

The gate offers the existing notme preset, an all-native preset, and seven
independent switches. `lib/environment.js` normalizes those choices; only chosen
location/timezone/language surfaces need geographic profile data. Forced timezones
use `buildManualOverride` from the cached notme workflow. A selection signature rejects
outdated checks when the user changes controls during a probe. WebRTC uses
a constructor guard on Anthropic pages and the two verification hosts. It blocks connections when selected;
other origins retain native WebRTC. Old browser-wide control is cleared on startup.

For the first protected document, the gate carries the checked profile in a URL
fragment. `content-inject.js` consumes it synchronously at `document_start` and
restores the original fragment before the page's first inline script. The bridge
then requests that tab's profile instead of replacing it with a generic exit
profile. This keeps tabs with different proxy exits independent.

The injector honors the per-visit flags instead of forcing Anthropic surfaces
on. With all page surfaces native, it returns before installing wrappers.
Protected frames without a delivered profile start with native reads until the
bridge arrives; spoofing is synchronous for the admitted top-level document.

The ordinary-extension gate governs network-stack requests, including HTTP
cache, but not existing Service Worker / CacheStorage responses or back-forward
cache restores. Chrome documents the Service Worker boundary in its
[DNR reference](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#interactions_with_service_workers).
An ordinary extension cannot promise zero cached page content before approval.
On each new protected navigation, `browsingData.remove` removes only Service
Workers and CacheStorage for the exact target origin. Cookies, localStorage,
IndexedDB and unrelated origins are preserved. An unapproved protected commit
returns to the gate, but this cannot undo content already rendered from cache.

### General profile refresh

1. `background.js` detects the visible exit IP location using multiple IP providers.
2. `lib/providers.js` normalizes provider responses and preserves IANA timezone IDs when providers return them.
3. `lib/geo.js` chooses a nearby residential-looking coordinate using Overpass/OpenStreetMap, with fallback logic when Overpass is unavailable.
4. `lib/locale.js` infers a plausible locale bundle from country code and timezone.
5. `background.js` stores the computed override and status in `chrome.storage.local`.
6. `content-bridge.js` runs in the isolated extension world, reads storage, and posts the payload to the MAIN world via `window.postMessage` (with a request/response handshake so delivery is robust regardless of script order).
7. `content-inject.js` runs in the page MAIN world at `document_start`, reads that payload, and patches browser APIs before normal page scripts run.
8. `background.js` installs a dynamic DNR rule to set the outgoing `Accept-Language` request header when language spoofing is enabled.

## Why there are two content scripts

Chrome extension isolated-world scripts can access `chrome.storage`, but page scripts cannot see their JavaScript objects. MAIN-world scripts can patch page-visible browser APIs, but cannot use extension APIs.

The bridge solves this split:

- `content-bridge.js`: isolated world, has `chrome.storage`, posts JSON to the MAIN world via `window.postMessage`.
- `content-inject.js`: MAIN world, receives that message, patches page-visible APIs.

`window.postMessage` is used rather than a shared DOM attribute or a `CustomEvent`: an attribute is observable by a generic `MutationObserver`, and a `CustomEvent`'s `detail` does not cross the isolated→MAIN world boundary in Chromium (it arrives as `null`). `postMessage` structured-clones the payload reliably across worlds and leaves no DOM mutation.

## Timezone implementation

`lib/timezone.js` computes the JavaScript `getTimezoneOffset` value for an IANA timezone at a specific `Date` instance. It uses `Intl.DateTimeFormat(..., { timeZone })` to format the same UTC instant as local wall time, then converts the difference back to the JavaScript sign convention:

- UTC+9 returns `-540`
- UTC-7 returns `+420`
- UTC-8 returns `+480`

This is DST-aware. The patched `Date.prototype.getTimezoneOffset` passes `this`, so historical/future dates use the correct offset for that date instead of the current offset.

## Language implementation

IP providers generally do not return a real user language. `lib/locale.js` uses deterministic offline inference:

- country code provides the default locale
- timezone refines multilingual countries where useful
- fallback is `en-US,en`

The resulting bundle is used for both JS-visible locale values and the HTTP `Accept-Language` header.

## Date virtualization

The wrappers share one source of truth in `lib/timezone.js`:

- `tzOffsetMinutes(tz, date)` — DST-aware `getTimezoneOffset` value.
- `wallClock(tz, date)` — the target-zone wall-clock components (shift the UTC instant by the offset, read UTC fields).
- `localWallToEpoch(tz, y, mo, …)` — the inverse, used by setters, the numeric constructor, and offset-less parsing, with a single DST re-check.
- `nativeDateStrings(tz, date)` / `tzName` / `formatGMT` — reproduce the native `toString` layout, including the localized zone long name.

Each Date wrapper is installed once and consults the live override state on every call; wrappers never stack. When a toggle is off (or override data hasn't arrived) every wrapper delegates to the captured native method.

## Browser and device identity

`lib/identity.js` builds one ordinary Chrome/Chromium profile from the original
UA's Chromium version and coarse OS family, using generic OS/device details.
The service worker stores that profile separately from IP overrides. The MAIN
injector has an immediate local fallback and adopts the stored profile through
the bridge, so this protection does not wait for IP/geolocation detection.

The injector patches `navigator.userAgent`, `appVersion`, `platform`, and
`vendor`. It keeps the genuine `NavigatorUAData` object and patches its prototype:
`brands`, `mobile`, `platform`, `toJSON()`, and `getHighEntropyValues()`.
`model` becomes empty; browser brands and full-version fields use the shared
profile. Native hint validation and permission checks run first. Unrelated
high-entropy fields, such as architecture and platform version, are retained.

Identity masking follows the per-visit choice only on Anthropic origins and
inherited-origin frames. The exact verification hosts `fuck-claude.vercel.app` and `fuck-claude.app` also use per-visit choices; other sites are not injected.

DNR rules synchronize `User-Agent`, `Sec-CH-UA`, `Sec-CH-UA-Mobile`,
`Sec-CH-UA-Platform`, `Sec-CH-UA-Model`, `Sec-CH-UA-Full-Version`, and
`Sec-CH-UA-Full-Version-List`. Only protected destinations in an admitted tab are covered. There are no global
header rules. Startup removes old rule IDs 9001–9005 and clears the old WebRTC
privacy override before settings are used.

This is page/API/header masking. It does not change the engine, real hardware,
IP, TLS fingerprint, or JavaScript identity in dedicated/shared/service workers.
Other extensions and browser policies can compete for request headers.

## WebRTC

When selected, the protected page guards `RTCPeerConnection` and its legacy
alias, rejecting construction with `NotAllowedError`. This disables that page's
WebRTC audio/video connections. The guard waits for the per-visit profile in
inherited frames by refusing construction while it is unknown; selecting native
restores normal construction once the profile arrives. Other origins do not run
this code. The privacy API is used only to read the current UDP policy and clear
legacy browser-wide control.

## Web Worker spoofing ("Spoof in Web Workers" toggle — experimental, default OFF)

Content scripts don't run inside worker scopes, so a fingerprinter can read the
real timezone/locale from a `new Worker(...)`. When enabled, notme wraps the
`Worker` constructor: for a classic dedicated worker it builds a small blob whose
body (1) runs a self-contained patch of `Date` (offset, local getters, string
methods, `toLocale*`) / `Intl` / `navigator` for the spoofed zone/locale,
(2) rewrites `importScripts`, `fetch`, and `XMLHttpRequest.open` to resolve
relative URLs against the original script URL, then (3) `importScripts` the
original script.

This is **off by default and experimental** because rewriting a worker through a
blob has boundaries a shim can't fully paper over:

- **CSP.** A policy that omits `blob:` (e.g. `script-src 'self'`) blocks the blob
  worker *asynchronously* — the constructor doesn't throw, so a try/catch can't
  catch it. To avoid silently killing the worker, notme runs a one-shot probe
  worker and only takes the blob path once blob workers are **confirmed** to run
  on the page; until then (and permanently on CSP-restricted pages) workers pass
  through natively (unspoofed but working).
- **`self.location`.** Inside the blob worker it is the blob URL. Workers that
  derive resource URLs from `self.location`, or use dynamic `import()`, can
  misbehave — this can't be rebased, which is why the feature is opt-in.
- Module workers (`{type:'module'}`), `SharedWorker`, `ServiceWorker`, and
  Worklets are passed through / not wrapped.
- The in-worker patch spoofs the timezone/locale *values*; it does not fully
  harden native-identity (`Function.prototype.toString`) inside the worker.

Any failure falls back to a normal, unpatched worker, so pages don't break — but
if a specific site's worker misbehaves, turn the toggle off.

## Font hiding ("Hide CJK fonts" toggle)

Width-based font probes render a string in `"'TestFont', <generic>"` and compare
the measured width against the generic baseline; an installed font shifts the
width. notme patches `CanvasRenderingContext2D.measureText` (and the
offscreen variant) plus `Element.getBoundingClientRect`/`getClientRects` and
`HTMLElement.offsetWidth`/`offsetHeight`: when the measured font-family names a
blacklisted CJK font (Microsoft YaHei, PingFang, SimSun, SimHei, KaiTi, MingLiU,
Source Han / Noto CJK, …, both Simplified and Traditional), those families are
stripped before measuring, so the probe reads the generic baseline and concludes
the font is not installed. This hides the OS/region signal (a Windows/macOS
Chinese font set contradicting, say, a Los Angeles exit IP). The DOM path only
acts on elements that declare a CJK font inline, so normal layout is untouched.

## Protected-site profile selection

The default notme preset selects the previous Anthropic protections. The per-visit
switches can restore any surface to the browser default:

- **Content script.** `content-inject.js` sets `ON_ANTHROPIC` when
  `location.hostname` matches one of the seven protected roots or a subdomain.
  `tzActive()` / `langActive()` / `fontActive()` use that tab's selected flags.
- **Header.** Per-tab rules modify only requests to the seven protected roots.
  Only explicitly selected language and identity values are applied.

Other sites retain native APIs and headers. The two exact verification hosts
also enter the per-navigation guard. Static rules 3 and 4 use exact host regexes
so unrelated Vercel applications and subdomains stay native. Their preflight
sends no request to the verification host: `claude.ai/cdn-cgi/trace` provides
the labeled Claude exit for profile preparation, alongside UDP and HTTP/3 diagnostics.
Their header rule is limited to the approved tab and exact destination host.
All protected pages receive the admitted tab profile synchronously in the entry
fragment, including the first inline script. Saved defaults only preselect the
next visit. Startup removes obsolete dynamic rules 19000 and 19001.

The experimental Web Worker feature is *not* force-enabled on Anthropic
(claude.ai is worker-heavy and the blob rewrite could break it); the main-thread
protections cover what the page's own JavaScript reads.

Extension-presence hygiene: the shared `window.GeoMirrorTZ` global is deleted
immediately after the injector captures it, and the isolated↔MAIN channel uses a
neutral `window.postMessage` marker, so a page can't trivially detect the
extension by a well-known global or attribute.

## Limitations

- This is browser-surface alignment, not a full anti-fingerprinting system (canvas image/WebGL/audio/screen are untouched; UA/UA-CH masking covers page APIs and identity headers only).
- Locale inference is heuristic; provider timezone quality depends on the IP geolocation provider.
- Worker coverage is limited to classic dedicated workers (see above); Shared/Service Workers and Worklets still read the host zone.
- Font hiding targets width probes; it does not alter canvas *pixel* readback (`toDataURL`/`getImageData`) fingerprints, and DOM probes that set the font via a CSS class rather than inline style are not covered.
- Extensions cannot inject into `chrome://` / `edge://`, the extension stores, or other privileged pages.
- Some platforms use high-entropy or non-browser signals (TLS/HTTP fingerprints, account history) that an extension cannot modify.

## Testing

Run:

```bash
npm install --ignore-scripts
npm test
# Requires Chromium (or CHROMIUM_PATH), OpenSSL and fontconfig:
npm run test:browser
node --check background.js
node --check content-inject.js
node --check content-bridge.js
node --check lib/providers.js
node --check lib/locale.js
node --check lib/timezone.js
node --check gate.js
```

Manual browser verification:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load this directory as an unpacked extension.
4. Trigger refresh in the environment page.
5. On a test page, verify:
   - `navigator.geolocation.getCurrentPosition(...)`
   - `navigator.language`
   - `navigator.languages`
   - `Intl.DateTimeFormat().resolvedOptions()`
   - `new Date().getTimezoneOffset()`
   - Network request `Accept-Language` header in DevTools.
