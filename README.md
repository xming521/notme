# notme

> Make your browser profile match your visible IP: geolocation, timezone, language, and `Accept-Language` — only on approved Anthropic / Claude pages.

notme is a Chrome Manifest V3 extension for people who use proxies, VPNs, remote desktops, or regional network exits and want the browser-visible environment to be internally consistent.

[中文说明](./README.zh-CN.md) · [Privacy policy](./PRIVACY.md) · [Technical notes](./docs/TECHNICAL.md)

---

## Anthropic navigation checks

Opening or reloading an Anthropic URL first redirects to a local environment selection page. Choose **Use notme spoofing**, **Use system defaults**, or set each surface independently. The static rules block the site's main HTML and subresources until the checks pass **and you click Confirm**. A previous visit or another tab does not authorize a new navigation.

The toolbar and navigation gate now share one Chinese environment page. All seven choices and the timezone selector are together; network details and advanced preferences start collapsed, while blocking failures expand automatically. Timezone, latency threshold, accuracy, refresh interval and optional token changes are saved immediately and trigger fresh checks. **Save as default** remembers the seven choices only for future Anthropic visits. Saving settings does not authorize a navigation.

The protected roots are `anthropic.com`, `claude.ai`, `claude.com`, `claude.app`, `claudeusercontent.com`, `claudemcpcontent.com`, and `claude.site`, including all their subdomains. Other sites, including fingerprint verification sites, retain their native environment.

Each check makes three cookie-free HTTPS requests to the actual destination's `/cdn-cgi/trace`, alongside third-party test and IP services and permitted STUN probes. **The region restriction covers mainland China (`CN`) and Hong Kong (`HK`) only: any valid IP observation from any source in either region blocks access.** Different exit IPs can result from split routing and are informational, not an error. Unknown regions stay unverified. A latency-only warning does not block access. Automatic spoofing still requires usable geolocation for the destination IP; native choices need no spoofing data. Confirmation rechecks every source, blocks a restricted region, and updates the profile for an allowed exit change. Changed settings or checks older than one minute require a fresh check.

The page also shows **UDP / STUN** and **HTTP/3 / QUIC** diagnostics. UDP uses Cloudflare's public `stun.cloudflare.com:3478` service under the current browser WebRTC policy; only a UDP server-reflexive response counts as success. Every observed UDP IP receives a country lookup; any mainland China or Hong Kong result blocks access. Other exit differences are described as possible split routing. STUN is explicitly a third-party reference, not Anthropic's path. When the browser reports non-proxied UDP protection is active, the protection check passes and STUN is skipped without changing that policy. A timeout means unverified, not proof that all UDP is blocked.

HTTP/3 uses Cloudflare's QUIC test host, `cloudflare-quic.com/cdn-cgi/trace`, as a third-party reference, making up to three sequential requests within eight seconds so the browser can learn Alt-Svc and retry. Only `http=http/3` verifies the HTTP/3 exit; HTTP/2/1.1 fallback and unknown protocols stay unverified. Every valid returned IP still participates in the mainland China / Hong Kong restriction, including fallback responses. The result explicitly describes the route to the test service, not Anthropic's route, and differences can result from split routing. This does not force HTTP/3 or test arbitrary UDP ports.

Spoofing follows notme's existing automatic or forced-timezone workflow. The location, timezone, language/request headers, browser/device identity, fonts, Web Worker and WebRTC each have a spoof/default switch. A forced timezone is preserved even when it differs from the exit IP. After confirmation, the tab receives its own selected profile; language and identity headers stay native when their switches use system defaults. The first inline script receives the selected profile; a second tab with a different regional exit does not overwrite it. Resources under the protected roots are allowed in that approved tab; their individual exits are not separately checked.

**Chrome extension boundary:** existing Service Worker / CacheStorage responses and back-forward cache restorations can bypass Chrome's declarative network rules. Therefore loading this extension in an ordinary browser does not guarantee that previously cached page content can never appear before confirmation. This boundary has been reproduced in Chromium; see [Chrome's DNR documentation](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#interactions_with_service_workers). On each protected navigation, notme removes Service Workers and CacheStorage for that exact target origin, preserving cookies, localStorage and IndexedDB. An unapproved cached commit is redirected back to the gate. These measures reduce cached bypasses but cannot guarantee zero rendering during a race or history restoration.

## Motivation: IP alone is not enough

Recent Claude / Anthropic account-ban controversies made one thing very clear: location-based risk controls can become brutal when they are applied mechanically. Many users reported that simply changing IPs, traveling, using VPNs, or having inconsistent regional signals could trigger account restrictions or bans. When a company such as Anthropic turns coarse address/location heuristics into account loss, the result is infuriating — but anger does not solve the operational problem.

The practical problem is this:

Most people only change their **IP address**. Their browser still exposes signals from somewhere else:

- `navigator.geolocation` may reveal the real physical location.
- `Date.prototype.getTimezoneOffset()` may reveal the local machine timezone.
- `Intl.DateTimeFormat().resolvedOptions().timeZone` may reveal the system timezone.
- `navigator.language` / `navigator.languages` may reveal the host language.
- the HTTP `Accept-Language` header may reveal another locale.

That mismatch is exactly the kind of thing automated risk systems can use as a proxy/VPN/fraud signal. notme exists to close that gap.

## What notme does

notme detects your visible **exit IP**, derives a plausible browser profile from that IP, and applies it locally inside Chrome:

| Surface | What notme changes |
| --- | --- |
| HTML5 geolocation | Spoofs `navigator.geolocation` to a residential-looking coordinate near the exit IP, and returns a genuine `GeolocationPosition`. |
| Geolocation permission | Reports geolocation permission as `granted` via a real `PermissionStatus`, to avoid permission-state mismatch. |
| **Whole `Date` local-time surface** | DST-aware IANA logic drives `getTimezoneOffset()` **and** every local getter (`getHours`/`getDate`/`getDay`/`getMonth`/`getFullYear`/…), the local setters, `toString`/`toDateString`/`toTimeString`, `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`, the numeric multi-arg constructor, offset-less `Date.parse`, and `Date()` called as a function — so no `Date` method contradicts the spoofed offset. |
| Intl timezone | Spoofs default `Intl.DateTimeFormat` timezone and `resolvedOptions().timeZone` (even when a locale is passed). |
| Browser language | Spoofs `navigator.language` and `navigator.languages`. |
| Browser / device brands | Presents ordinary Chrome/Chromium UA and UA-CH brands, masks the device model, and synchronizes `User-Agent` / identity client-hint request headers. Controlled by the per-visit choice on Anthropic pages only. |
| Intl locale | Spoofs the default locale for `DateTimeFormat`, `NumberFormat`, `Collator`, `RelativeTimeFormat`, `PluralRules`, `ListFormat`, `DisplayNames`, `Segmenter`, `DurationFormat`, plus `Number`/`Array`/`BigInt.prototype.toLocaleString`. |
| Request language | Sets the outgoing `Accept-Language` header only for approved Anthropic destinations, on **all** request types via Chrome `declarativeNetRequest`. |
| WebRTC IP leak | Optionally blocks `RTCPeerConnection` and its legacy alias only on Anthropic pages. This can disable WebRTC audio/video features on those pages. |
| Web Workers | Optionally (experimental, off by default) extends timezone + locale spoofing into dedicated Web Workers (where fingerprinters read the real timezone to bypass main-thread spoofing). |
| CJK fonts | Optionally hides OS/region-revealing Chinese fonts (Microsoft YaHei, PingFang, SimSun, …, Simplified + Traditional) from canvas `measureText` and DOM width probes. |
| Anti-detection | Spoofed functions report native to both `fn.toString()` and the intrinsic `Function.prototype.toString.call(fn)`; the override payload is not left in the DOM, and no global (like `window.GeoMirrorTZ`) is left for a page to probe. |
| **Anthropic pages** | The seven protected roots and their subdomains receive environment selection, network checks and explicit confirmation. Each surface can use notme spoofing or the system default. |

Only the seven Anthropic roots and their subdomains receive content scripts and selected spoofing. Ordinary sites and fingerprint test sites remain native. Web Worker spoofing is optional and off by default.

The goal is simple: if your IP looks like Tokyo, the browser should not still look like Shanghai, Los Angeles, or Berlin — and no single `Date` or `Intl` call should quietly give it away.

## Privacy model

notme is local-first and auditable:

- No account.
- No telemetry.
- No analytics.
- No page-content reading.
- No remote configuration.
- Computed overrides and settings are stored in `chrome.storage.local`.

Important accuracy note: notme is not a zero-network extension. To match your current exit IP automatically, it must call explicitly listed public IP/geolocation/map APIs through Chrome’s network stack. These requests are limited to:

- detecting the exit IP location,
- finding nearby residential roads,
- reverse-geocoding a display address for the environment page.
- checking the requested Anthropic host's `/cdn-cgi/trace` and locating its observed exit IP.

It does not upload page content or browsing history. See [PRIVACY.md](./PRIVACY.md) and [docs/TECHNICAL.md](./docs/TECHNICAL.md) for the exact data flow.

## How it works

```
   proxy / VPN / remote exit          Chrome + notme
              │                              │
              ▼                              ▼
        visible exit IP ───────► background service worker
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
          IP geolocation      residential roads      reverse geocode
          + timezone          near exit IP            for environment display
                 │                    │                    │
                 └──────────────► computed override ◄──────┘
                                      │
                         stored in chrome.storage.local
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
          isolated-world bridge              MAIN-world injector
          reads extension storage            patches page-visible APIs
                    │                                   │
                    └────────────► page sees a coherent browser profile
```

Technical sequence:

1. `background.js` detects the visible exit IP using multiple providers.
2. `lib/providers.js` normalizes IP geolocation data and preserves provider timezone fields such as `Asia/Tokyo`.
3. `lib/geo.js` chooses a nearby residential-looking coordinate using OpenStreetMap / Overpass.
4. `lib/locale.js` infers a plausible locale bundle from country code + timezone.
5. `background.js` stores the override locally and installs a dynamic `Accept-Language` header rule.
6. `content-bridge.js` runs in Chrome’s isolated extension world, reads local storage, and posts the payload to the MAIN world via `window.postMessage`.
7. `content-inject.js` runs in the page’s MAIN world at `document_start` and patches the browser APIs before page scripts run.

## Install

### Option A — load unpacked (Chrome / Brave / any Chromium)

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `notme` folder.
6. Pin notme and click its icon to open the environment page. Use **刷新环境** (Refresh environment) to update the profile.

### Option B — load unpacked (Microsoft Edge)

notme is a standard Chromium MV3 extension, so Edge loads it the same way:

1. Download or clone this repository.
2. Open `edge://extensions` (type it into the address bar).
3. Toggle **Developer mode** on (bottom-left).
4. Click **Load unpacked**.
5. Select the `notme` folder (the one containing `manifest.json`).
6. Pin notme from the puzzle-piece menu, open it, and click **刷新环境** (Refresh environment).

Edge honors the same `chrome.*` APIs notme uses (`declarativeNetRequest`, `alarms`, `privacy`), so all features work unchanged. If the environment page shows an error, click **刷新环境** (Refresh environment) once your proxy/VPN is connected.

### Option C — Chrome Web Store / Edge Add-ons

Store listings are planned. Until then, use the unpacked extension.

### Updating the unpacked extension

From 1.8.1, the manifest contains a fixed public key. The extension ID is
`jnppijkakhomofmffakonooanpggmoff`, independent of the directory path. Keep this
key unchanged in future versions. To update, overwrite the existing directory
and click Reload, or load a new unpacked directory in the same browser profile;
the ID and local settings stay the same. The new directory must remain on disk.

When moving from 1.8.0 or earlier, disable the old copy before loading 1.8.1.
Those releases used path-derived IDs, so this is a one-time ID change and their
settings are not automatically transferred. Reconfigure once in the new copy.
The published key is public; the extension does not require a private key.

## Verify it works

Open a fingerprint/location test page and check these values:

```js
navigator.language
navigator.languages
Intl.DateTimeFormat().resolvedOptions()
new Date().getTimezoneOffset()
navigator.geolocation.getCurrentPosition(console.log, console.error)
```

Also check DevTools → Network → request headers and confirm `Accept-Language` matches the spoofed locale.

Public checks show the native environment because they are outside the protection scope. To inspect a spoofed profile, run the commands above in an approved Anthropic page. Public comparison pages:

- https://browserleaks.com/geo
- https://browserleaks.com/javascript
- https://browserleaks.com/headers

## Settings

All choices apply only to Anthropic visits. Updating to 1.8.2 clears the legacy global header rules and WebRTC control. Reload affected open pages once to discard old page wrappers; the fixed extension ID stays unchanged.

- **Location spoof** — enable/disable geolocation override.
- **Timezone spoof** — enable/disable the `Date` and `Intl` timezone override.
- **Language spoof** — enable/disable `navigator.language(s)`, Intl locale, and `Accept-Language` header override.
- **Block WebRTC IP leak** — disables WebRTC connections only on the selected Anthropic page. Default on; select system default to use its native WebRTC features. This may affect WebRTC audio/video on that page.
- **Hide CJK fonts** — strip region-revealing Chinese fonts from canvas/DOM width probes so they read as not-installed. Default on.
- **Browser and device identity** — masks UA / UA-CH and the device model only for the selected Anthropic visit.
- **Spoof in Web Workers** *(experimental)* — extend timezone/locale spoofing into dedicated Web Workers. **Default off**, because it reloads worker code through a blob shim which can break WASM/bundled workers that rely on `self.location`. It probes for CSP `blob:` support and falls back to a native worker when blocked (so it won't silently kill workers), but enable it only if you need worker-level timezone hiding, and turn it off if a site's worker misbehaves.
- **Force timezone** — pick a zone to **override exit-IP detection entirely**: the timezone, locale, and a representative coordinate are forced to that zone regardless of where the exit IP resolves (and regardless of whether detection succeeds). Use this to present a fixed non-China profile. Leave it on *Auto — use exit IP* to mirror the detected exit location instead. **Caveat:** forcing a timezone that differs from your real exit IP only hides it from *browser-side* checks (e.g. an Anthropic page reads the `Intl` timezone); a service that reads your exit IP server-side can still see the IP↔timezone mismatch — the real fix for that is a proxy that exits where you want to appear.
- **Reported accuracy (m)** — reported GPS accuracy, default 30 m.
- **Auto-refresh interval (minutes)** — how often notme re-detects the exit IP.
- **ipinfo.io token (optional)** — improves fallback reliability if you have a token.
- **Network warning threshold (ms)** — maximum average probe latency for Anthropic admission; default 1500 ms. Upgrades migrate the previous 500 ms default once; other saved thresholds are preserved.

## Claude Code (terminal): a separate timezone channel

The extension above spoofs your **browser's** timezone. **Claude Code** in the
terminal is a different process that reports the **OS timezone** (via the `TZ`
env var) in its system prompt — a browser extension can't touch it. To present a
US timezone to Claude Code, add a `claude` wrapper with the scripts in
[`tools/claude-tz/`](./tools/claude-tz/):

```bash
cd tools/claude-tz && bash install.sh          # macOS / Linux / WSL (zsh/bash/fish)
# Windows PowerShell:  powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It wraps only the `claude` command, leaving the rest of your shell alone. See
[tools/claude-tz/README.md](./tools/claude-tz/README.md) for per-shell snippets,
other US zones, and the caveat (it changes the reported timezone, not your exit
IP). Which channel you need:

| You use | Timezone from | Fix |
| --- | --- | --- |
| claude.ai web / fingerprint tests | the **browser** | the notme extension (*Force timezone*) |
| Claude Code in the **terminal** | the OS **`TZ`** | `tools/claude-tz/` |

## Why each permission

| Permission | Why |
| --- | --- |
| `storage` | Save settings and computed overrides locally. |
| `alarms` | Schedule periodic exit-IP refresh. |
| `declarativeNetRequest` | Set the outgoing `Accept-Language` header without reading page traffic. |
| `privacy` | Read the existing policy for UDP diagnostics and release old versions' browser-wide WebRTC override. New protections stay in the selected page. |
| Anthropic-only content scripts | Patch APIs only on the seven protected roots and their subdomains, including inherited-origin frames. |
| Scoped host permissions | Access Anthropic destinations and the listed IP/geolocation/map providers. Other website origins are excluded. |

## If you do not want to install this extension

You can ask your own coding agent to build a local version. Copy this prompt:

```text
Build a Chrome Manifest V3 extension that aligns browser-visible location signals with the current visible exit IP.

Requirements:
1. Detect the browser's visible exit IP location through Chrome's network stack using multiple fallback IP geolocation providers.
2. Preserve provider fields for country code, city/region/country, latitude/longitude, ISP, and IANA timezone.
3. Pick a nearby residential-looking coordinate instead of the raw IP centroid. Use OpenStreetMap Overpass highway=residential results when available, and a safe jitter fallback otherwise.
4. Infer a plausible locale bundle from country code + timezone: navigator.language, navigator.languages, and Accept-Language.
5. Store settings and computed overrides only in chrome.storage.local. Do not add telemetry, analytics, accounts, remote config, or page-content collection.
6. Use two content scripts:
   - an isolated-world bridge that can read chrome.storage and publish a JSON payload to the DOM;
   - a MAIN-world injector at document_start that patches page-visible APIs.
7. Patch:
   - navigator.geolocation.getCurrentPosition / watchPosition / clearWatch
   - navigator.permissions.query for geolocation
   - Date.prototype.getTimezoneOffset with DST-aware IANA timezone logic using the receiver Date instance
   - Intl.DateTimeFormat default timezone and resolvedOptions().timeZone
   - navigator.language and navigator.languages
   - Intl.DateTimeFormat / Intl.NumberFormat / Intl.Collator default locale
8. Use chrome.declarativeNetRequest to set the outgoing Accept-Language header when language spoofing is enabled.
9. Share one Chinese environment page between the toolbar and navigation gate, with seven spoof/default choices, an inline timezone selector and collapsed advanced preferences.
10. Add tests for timezone DST offsets, locale inference, provider parsing, and manifest injection order.
11. Document the privacy model clearly: no telemetry, no page-content reading, local storage only, and explicit provider requests only for exit-IP/location matching.
```

## What v1.2 fixed

These were real gaps in earlier versions and are now closed:

- **`Date` self-contradiction.** Previously only `getTimezoneOffset()` and `Intl.DateTimeFormat` were spoofed, so `new Date().getHours()`, `.toString()` (`… GMT+0800 (China Standard Time)`), `.toLocaleString()`, `Number.prototype.toLocaleString`, and most of the `Intl.*` family still leaked the host machine's timezone/locale — a one-line cross-check unmasked the spoof. The whole `Date` local-time surface and every locale-aware `Intl` constructor are now virtualized in the exit-IP zone.
- **`Accept-Language` was silently not applied.** `declarativeNetRequest` `modifyHeaders` needs host access to the visited site; the old manifest only listed the IP-API domains, so the header rule was skipped on real sites. `host_permissions` covers only Anthropic and diagnostic providers, and the rule covers **all** resource types (previously only main-frame/sub-frame/XHR — images, fonts, scripts, and beacons leaked the real language).
- **`Intl.DateTimeFormat` dropped the timezone** in the no-locale path (a positional-argument bug), leaking the host timezone whenever timezone spoofing ran with language spoofing off. Fixed.
- **WebRTC could leak the real IP** around the proxy. Now optionally disabled only on the selected Anthropic page.
- **Spoof detection.** `Function.prototype.toString.call(fn)` used to return the wrapper source; the override payload sat readable in `<html data-notme>`; `permissions.query` returned a plain object. All fixed.
- **Opaque-origin frames.** `about:blank` / `srcdoc` / `data:` / `blob:` child frames are now patched (`match_origin_as_fallback`).

## Remaining limitations (honest list)

- notme improves consistency of location/timezone/locale and browser/device signals. It is **not** a complete anti-fingerprinting system: canvas *pixel* readback, WebGL, audio, and screen are untouched. Browser/device masking covers page JavaScript and outgoing identity headers; it does not change the browser engine, real hardware, TLS fingerprints, or JavaScript identity inside workers. Font hiding covers CJK-font *width* probing only.
- IP geolocation is approximate; the residential coordinate is a plausible nearby point, not your real address.
- Locale inference is heuristic — IP providers do not know your real language, so it is derived from country code + timezone.
- **Worker coverage is partial.** Classic dedicated Web Workers are now spoofed (via the "Spoof in Web Workers" toggle), but **Shared Workers, Service Workers, Worklets, and module workers still read the host timezone/locale** — a content script can't patch those scopes without breaking them.
- Browser extensions cannot inject into `chrome://` / `edge://`, the extension stores, or other privileged pages.
- Some platforms use additional risk signals outside browser JavaScript and headers (TLS/HTTP fingerprints, account history, behavioral signals) that no browser extension can change.

## Development

Project layout:

```
notme/
├── manifest.json
├── background.js
├── content-bridge.js
├── content-inject.js
├── docs/
│   └── TECHNICAL.md
├── lib/
│   ├── geo.js
│   ├── locale.js
│   ├── providers.js
│   └── timezone.js
├── gate.html
├── gate.css
├── gate.js
├── test/
│   └── run-tests.js
└── icons/
```

Checks:

```bash
node test/run-tests.js
node --check background.js
node --check content-inject.js
node --check content-bridge.js
node --check lib/providers.js
node --check lib/locale.js
node --check lib/timezone.js
node --check gate.js
```

After changing files, reload the extension in `chrome://extensions`.

## Contributing

Pull requests welcome. Keep the permission surface minimal and preserve the no-telemetry, no-page-content-reading guarantees.

## License

[MIT](./LICENSE)
