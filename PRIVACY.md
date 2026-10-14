# Privacy Policy

notme is designed to be minimal and auditable. This page describes exactly
what data the extension touches, where it goes, and where it does **not** go.

## The short version

notme sends no telemetry or analytics. Its background requests are limited to
the destination and third-party network diagnostic endpoints and the geolocation/map services
listed below, using the data needed for those checks.

## What the extension does

1. On startup, on a schedule, and when you click *Refresh*, the background
   service worker asks a geolocation service for the location of your current
   **outbound IP**. Because the request travels through Chrome's normal network
   stack, it sees the same IP that websites see (i.e. through your proxy/VPN if
   you use one).
2. It then queries the OpenStreetMap Overpass API for residential roads near
   that location and picks a point on one of them as the override coordinate.
3. It optionally asks BigDataCloud for a human-readable address of that point,
   purely so the environment page can display it.
4. A content script injects the chosen coordinate into `navigator.geolocation`
   only on selected Anthropic pages and the two listed verification sites. Other sites remain native.
5. Page scripts also apply the configured timezone, locale, and font protections.
   Browser/device masking presents ordinary Chrome/Chromium brands and an empty
   device model, using a generic profile for the reported Chromium version and
   OS family. Anthropic pages and the two verification hosts use per-visit choices. Other sites,
   except the two listed verification sites, retain native APIs.
6. Declarative rules modify language and identity headers only on approved
   Anthropic destination requests and the two exact verification hosts. Browser/device masking adds no network endpoints or telemetry.
7. Before an Anthropic navigation, the local check page requests the target
   host's `/cdn-cgi/trace` three times without cookies, credentials or a referrer.
   Confirmation repeats this probe. The target's reported exit IP is used for an
   explicit IP geolocation lookup; this handles proxies that route destinations
   through different exits.
8. When the current WebRTC policy permits it, the local check page uses a
   data-channel ICE gather to send UDP/STUN probes to Cloudflare. No microphone,
   camera, remote peer, cookies or credentials are used. The STUN server sees the
   source address of that UDP path, which may differ from the HTTPS proxy exit.
   With non-proxied UDP protection active, no STUN probe is sent.
   Each observed STUN IP is sent to the listed geolocation providers for a country
   lookup. The check page waits for these lookups before enabling confirmation.
9. Each preflight also makes up to three sequential, cookie-free requests to
   Cloudflare's QUIC test host, `cloudflare-quic.com/cdn-cgi/trace`, within an
   eight-second timeout. Only a response reporting `http=http/3` verifies an
   HTTP/3 exit. Its IP and country are compared with the destination's observed
   exit as a third-party reference; this does not verify Anthropic's HTTP/3 path.
10. Preflight and confirmation also query the listed IP services for their
    observed default exit. Every valid observed IP and region, including earlier
    provider attempts and HTTP/2 fallback, participates in one region rule:
    mainland China (`CN`) or Hong Kong (`HK`) blocks access regardless of source.
    Different IPs alone do not block access. Confirmation repeats the checks,
    including permitted STUN probes and their country lookups.

## Network requests (the complete list)

| Host | Purpose | Data sent |
| --- | --- | --- |
| `reallyfreegeoip.org` | Primary IP geolocation | GET request only — your exit IP is visible to the service as the source address |
| `ipwho.is` | Fallback IP geolocation | GET only |
| `ipapi.co` | Fallback IP geolocation | GET only |
| `ipinfo.io` | Fallback IP geolocation; optional token if you provide one | GET; your token if entered |
| Requested host under `anthropic.com`, `claude.ai`, `claude.com`, `claude.app`, `claudeusercontent.com`, `claudemcpcontent.com`, `claude.site` | HTTPS connectivity and destination-exit check | GET `/cdn-cgi/trace`; no cookies or credentials |
| `stun.cloudflare.com:3478/udp` | UDP response and exit-address diagnostic | STUN binding packets; the UDP source IP is visible to the service |
| `cloudflare-quic.com` | Third-party HTTP/3 exit reference | GET `/cdn-cgi/trace`; no cookies, credentials or referrer; the connection's source IP is visible to the service |
| `overpass-api.de`, `overpass.kumi.systems`, `maps.mail.ru/osm/tools/overpass` | Find nearby residential roads (OpenStreetMap) | The exit-IP latitude/longitude |
| `api.bigdatacloud.net` | Reverse-geocode the chosen point for display | The chosen override latitude/longitude |

These are the background endpoints used by the extension. Explicit destination-IP
and STUN-IP lookups send those observed IPs to `ipwho.is`, `ipapi.co`, or `ipinfo.io`; these
services may see a different source IP under split routing. Host access is
limited to the seven Anthropic roots, the two verification hosts and listed diagnostic providers. Content
scripts match Anthropic origins, the two exact verification hosts and inherited-origin frames.

## What is stored, and where

- The detected IP, the chosen override coordinate, and your settings are stored
  locally in Chrome's extension storage (`chrome.storage.local`). Geolocation
  and map queries transmit the IP or coordinates described above.
- A generic browser/device profile is stored locally to keep page API values and
  outgoing identity headers consistent. The original device model is not stored.
- Nothing is written to disk outside Chrome's own storage.
- The pending target URL, check results and each tab's checked profile are held
  in `chrome.storage.session` for the browser session. They are removed when the
  tab closes or leaves the protected site; they are not uploaded as history.
  Per-visit spoof/default flags, including page-local WebRTC protection, are
  stored with that profile. No browser-wide WebRTC override is applied.
  The UDP diagnostic retains only the resulting public-address summary, not SDP
  or host/mDNS candidate addresses. The third-party HTTP/3 diagnostic retains
  only the reported exit IP, country, data-center code, protocol and probe error.
  Region observations retain each detected IP, reported region and source for
  the current check, so a restricted result cannot be overwritten by a later
  allowed one. Unknown regions are recorded as unverified.
- The checked profile is temporarily carried in a URL fragment on admission.
  Fragments are not sent in HTTP requests; the MAIN-world injector consumes it
  at document start and restores the original fragment.

## What the extension does NOT do

- No analytics, no telemetry, no crash reporting, no tracking pixels.
- No reading of page content, cookies, credentials, or form data. Content scripts
  read browser API values needed for the profile and patch browser-visible
  location, timezone, locale, font, and browser/device surfaces.
- No background data resale or "SDK" of any kind.
- No account, no sign-up, no login.

## A note on trust

Content scripts run on the seven Anthropic roots and their subdomains, plus the exact hosts `fuck-claude.vercel.app` and `fuck-claude.app`. Verification sites also require selection and confirmation before every visit or reload. Before confirmation, the extension sends no request to those hosts; it checks `claude.ai/cdn-cgi/trace` and prepares the profile alongside the listed third-party diagnostics and IP services. Their language and identity headers are modified only when selected; no other Vercel hosts are included.
Host permissions additionally allow the public IP/geolocation/map endpoints.
The scripts do not read page contents. Header rules apply only within the approved tab to Anthropic destinations or the selected exact verification host. On upgrade, old global header rules and notme's old
WebRTC privacy override are removed.

`tabs` and `webNavigation` associate the pending URL and admission rules with
the correct tab and navigation. The guard does not inspect page contents.
`browsingData` removes Service Workers and CacheStorage only for the protected
target origin on navigation. It does not delete cookies, localStorage, IndexedDB,
saved passwords or unrelated website data.

If you are privacy-conscious, you can run it unpacked from source so you can
read and rebuild it yourself at any time.

## Changes

Any future change to this policy will be reflected in this file and noted in the
changelog.

The gate URL fragment retains the complete pending destination so browser session restoration can recover it. It stays in the local browser URL/history and is not sent as part of diagnostic requests. Restoring an address never restores admission; a fresh check and confirmation are required.

The `declarativeNetRequestFeedback` permission observes actual rule matches in unpacked installations. Block notices show only the source and destination hostnames locally, without URL paths or query parameters. The `notifications` permission displays the notice; a per-tab session flag deduplicates it until navigation or tab closure. No additional content scripts or host permissions are added.
