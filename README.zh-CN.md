# notme

> 让浏览器画像与当前出口 IP 保持一致：地理位置、时区、语言、`Accept-Language` —— 用于确认后的 Anthropic / Claude 页面及指定的两个检测站。

notme 是一个 Chrome Manifest V3 扩展，适合使用代理、VPN、远程桌面、跨区出口节点的人。它解决的问题不是“换 IP”，而是“换了 IP 之后，浏览器仍然暴露出另一个地区的环境”。

[English](./README.md) · [隐私政策](./PRIVACY.md) · [技术说明](./docs/TECHNICAL.md)

---

## 实用功能

| 功能 | 使用效果 |
| --- | --- |
| 每次访问先选择环境 | 打开或刷新保护网站时，先检查，再由你确认进入；设置与环境选择使用同一页面。 |
| 按项选择伪装或系统默认 | 位置、时区、语言与请求头、设备标识、字体、Web Worker、WebRTC 分别选择；位置还可选“不提供位置”，默认不提供坐标。可保存下次访问的预选。 |
| 限定网站、标签页独立 | 仅在确认后的 Anthropic / Claude 和两个指定检测站应用所选环境，不修改其他网站的语言、时区等信息；不同标签页互不覆盖。 |
| 出口与协议诊断 | 网络检查置顶，分别显示目标站、Cloudflare 测试站与 UDP 出口。HTTP/3 按实际协议验证；回落到 HTTP/2 仍显示测试站观察到的 IP。 |
| 最近 10 次 IP 记录 | 按实际检测域名保留最近 10 次访问的有效出口 IP 和时间，可展开查看，重启后保留；同次访问重检不重复计数。 |
| 醒目的 IP 变化提醒 | 本次出口与上次不同，页面顶部用橙色提示框分别显示上次、本次 IP。变化本身不阻止访问，地区限制仍生效。 |
| 15 秒内快速确认 | 检查完成后 15 秒内确认直接进入，不重复探测；超时自动复查，UDP 与 HTTPS / HTTP3 复查并行。修改设置使旧结果失效，切换代理后应手动重新检查。 |
| 重启后恢复原网址 | 检查页保留完整目标地址，恢复标签页后重新检查并确认；旧版已丢失的地址需从浏览器历史记录找回。 |
| 兼容第三方出口检测 | 放行保护域名精确 `/cdn-cgi/trace` 路径的 HTTPS GET / fetch 请求。普通网页的其他请求被拦截时，图标与系统通知提醒，每次页面导航只提醒一次。实时提醒适用于“加载已解压扩展”。 |
| 固定扩展 ID | 更新时覆盖原目录并重新加载，保持扩展身份与已保存配置。 |

两个指定检测站为 `fuck-claude.vercel.app` 与 `fuck-claude.app`，进入前统一检测 `claude.ai` 的出口，确认后仍进入原检测站。记录与提醒针对诊断接口看到的**客户端出口 IP**，不是网站服务器 IP；IP 记录仅保存在本机。延迟警告默认 **1500 ms**，可在高级设置调整。

## Anthropic 访问前检查

每次打开或刷新 Anthropic 网址，先进入本地环境选择页。可以选择 **使用 notme 伪装**、**全部使用系统默认**，也可以逐项自定义。静态规则提前拦截正式 HTML 和子资源；检查全部通过后，还需要你点击 **确认并访问**。以前访问过、其他标签页已放行，都不能代替这次确认。

工具栏图标和访问前检查现在打开同一个中文页面：七项环境开关与时区选择在一起，网络检查置顶，目标站、Cloudflare 测试站和 UDP 分成三张卡片，出口 IP、地区、实际协议与延迟清楚分行显示；正文使用 16 px 中文无衬线字体，高级设置默认收起。HTTP/2 回退也显示 Cloudflare 测试站看到的出口 IP 与地区，HTTP/3 状态只显示一次。查 IP 服务继续参与地区检查，不再单独占一行。时区、延迟阈值、定位精度、刷新间隔和可选 Token 修改后自动保存，并重新检查；点击 **保存为默认** 可记住当前七项选择，用于下一次 Anthropic / Claude 访问和指定检测站。保存配置不会代替访问确认。延迟警告阈值默认 1500 ms；升级时仅将旧默认值 500 ms 迁移一次，其他已保存的阈值保留。

覆盖 `anthropic.com`、`claude.ai`、`claude.com`、`claude.app`、`claudeusercontent.com`、`claudemcpcontent.com`、`claude.site` 及它们的所有子域。`fuck-claude.vercel.app` 与 `fuck-claude.app` 每次打开或刷新也先选择本次环境，再确认进入，七项开关独立生效，无需先保存默认配置。确认前不会请求这两个检测站，改用 `claude.ai/cdn-cgi/trace` 检测 Claude 出口，并结合第三方 IP、UDP 与 HTTP/3 诊断准备环境，界面明确标注 `claude.ai`。只匹配这两个完整域名，其他网站和 Vercel 应用保持原生环境。

每次检查向实际目标域名的 `/cdn-cgi/trace` 发起三次不带 Cookie 的 HTTPS 请求，并检查第三方测试站、查 IP 服务和允许执行的 STUN 探测。**地区限制只有中国大陆（`CN`）与香港（`HK`）：任何来源、任何一次有效检测发现这两个地区的 IP 都禁止访问。** 出口 IP 不同可能由分流产生，只作信息说明，不判定异常；地区未知显示未确认，不冒充已验证。纯延迟警告不会阻止访问。自动伪装仍需要目标 IP 的可用地理数据，系统默认无需伪装数据。检查完成后 15 秒内确认直接使用本次结果；超过 15 秒自动复查所有来源，发现限制地区仍会拦截，允许地区的出口变化会更新本次环境。设置或选择改变会使旧检查失效；切换代理线路后请手动重新检查。

同时显示 **UDP / STUN** 和 **HTTP/3 / QUIC** 诊断。UDP 使用 Cloudflare 公共 `stun.cloudflare.com:3478` 服务，遵循浏览器当前 WebRTC 策略，只有收到 UDP server-reflexive 响应才算成功。每个探测到的 UDP IP 都会查询地区；任一中国大陆 / 香港 IP 会拦截，其他出口差异只显示分流说明。STUN 明确标注第三方参考，不代表 Anthropic 的入口。读取到非代理 UDP 保护策略实际生效时，显示防护通过并跳过 STUN，不临时关闭保护。超时表示未验证，不能据此认定所有 UDP 都被封锁。

HTTP/3 使用 Cloudflare 官方 QUIC 测试站 `cloudflare-quic.com/cdn-cgi/trace` 作为第三方参考，先预热再重试，最多三次、共八秒。只有测试站实际返回 `http=http/3` 才展示已验证的 HTTP/3 出口；HTTP/2/1.1 回退或未知协议仍显示 HTTP/3 未验证，但已取得的 IP 地区照常参加地区检查，不能跳过中国大陆 / 香港拦截。结果明确标注“仅代表到测试站的出口，不代表 Anthropic，可能因分流而不同”。普通扩展不能强制协商 HTTP/3，也不测试任意 UDP 端口。

伪装沿用 notme 原有的自动检测或手动时区流程。地理位置默认不提供坐标，也可选择伪装或系统默认；时区、语言及请求头、浏览器与设备标识、字体、Web Worker、WebRTC 可独立选择伪装或系统默认。手动时区即使与出口地区不同，也按原有流程保留。确认后，该标签页按本次选择生效；语言或浏览器标识选择默认时，请求头也保留原生值。第一个内联脚本就能读取所选环境。不同地区的标签页互不覆盖。已确认标签页可以加载上述保护域名的子资源，子资源各自的出口没有逐一检查。

**普通扩展的边界：** 站点已有的 Service Worker / CacheStorage 响应和前进、后退时的页面缓存恢复，可能绕过 Chrome 的声明式网络规则。因此，在普通浏览器里加载扩展，无法保证此前缓存的页面内容绝不会在确认前出现。该问题已在 Chromium 实测复现，参见 [Chrome 官方说明](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#interactions_with_service_workers)。每次保护域名导航时，会清理该目标 origin 的 Service Worker 与 CacheStorage，保留 Cookie、localStorage 和 IndexedDB；未确认的缓存页面提交会被送回选择页。这能减少缓存绕过，但不能保证竞争时序和历史恢复中绝无内容短暂显示。

## Motivation：只换 IP 远远不够

最近 Claude / Anthropic 的封号风波让很多人意识到一个现实问题：平台的风控如果机械地依赖地址、地区、登录环境等信号，就可能非常粗暴。很多用户反馈过，只是换了 IP、旅行、使用 VPN、或者浏览器环境和 IP 地区不一致，就可能触发账号限制甚至封禁。

Anthropic（Claude 的母公司）把这类粗糙的位置/地址启发式信号变成账号损失风险，这种做法当然令人愤怒。但愤怒解决不了实际问题。我们能做的是把自己的浏览器环境整理得更一致，减少无谓的风险信号。

最常见的问题是：多数人只换了 **IP 地址**，但没有同步更换浏览器暴露出来的其他信息。

- `navigator.geolocation` 仍然可能暴露真实物理位置。
- `Date.prototype.getTimezoneOffset()` 仍然暴露本机时区。
- `Intl.DateTimeFormat().resolvedOptions().timeZone` 仍然暴露系统时区。
- `navigator.language` / `navigator.languages` 仍然暴露本机语言。
- HTTP `Accept-Language` 请求头仍然暴露另一个语言环境。

这些信号一旦互相矛盾，就会形成非常典型的“代理/VPN/异常环境”画像。notme 的目标就是把这条链补齐。

## 使用前后有什么变化

### 使用前：只换 IP，浏览器画像仍然分裂

```mermaid
flowchart LR
  IP["出口 IP<br/>Tokyo, JP"]:::good
  GEO["navigator.geolocation<br/>Shanghai, CN"]:::bad
  TZ["Timezone<br/>Asia/Shanghai"]:::bad
  LANG["Language<br/>zh-CN"]:::bad
  AL["Accept-Language<br/>zh-CN,zh"]:::bad
  SITE["网站 / 风控系统<br/>看到互相矛盾的信号"]:::warn

  IP --> SITE
  GEO --> SITE
  TZ --> SITE
  LANG --> SITE
  AL --> SITE

  classDef good fill:#e6ffed,stroke:#2ea44f,color:#111;
  classDef bad fill:#ffeef0,stroke:#d73a49,color:#111;
  classDef warn fill:#fff5b1,stroke:#9a6700,color:#111;
```

### 使用后：浏览器画像跟随出口 IP

```mermaid
flowchart LR
  IP["出口 IP<br/>Tokyo, JP"]:::good
  GM["notme<br/>本地计算一致画像"]:::core
  GEO["navigator.geolocation<br/>Tokyo 附近住宅坐标"]:::good
  TZ["Timezone<br/>Asia/Tokyo"]:::good
  LANG["Language<br/>ja-JP / ja"]:::good
  AL["Accept-Language<br/>ja-JP,ja;q=0.9,..."]:::good
  SITE["网站 / 风控系统<br/>看到更一致的地区画像"]:::good

  IP --> GM
  GM --> GEO --> SITE
  GM --> TZ --> SITE
  GM --> LANG --> SITE
  GM --> AL --> SITE

  classDef good fill:#e6ffed,stroke:#2ea44f,color:#111;
  classDef core fill:#ddf4ff,stroke:#0969da,color:#111;
```

### 覆盖了哪些信号

| 信号 | 使用前常见状态 | 使用 notme 后 |
| --- | --- | --- |
| 出口 IP | 代理/VPN 节点地区 | 不改变 IP，只读取当前出口 IP |
| HTML5 定位 | 真实设备位置或系统位置 | 出口 IP 附近住宅感坐标，返回真正的 `GeolocationPosition` |
| 定位权限 | 可能显示未授权/真实状态 | 返回真正的 `PermissionStatus`，state 为 `granted` |
| **整个 `Date` 本地时间面** | 只有 `getTimezoneOffset` 被改，`getHours`/`toString`/`toLocaleString` 等仍暴露本机时区 | `getTimezoneOffset` **以及** 所有本地 getter/setter、`toString`/`toDateString`/`toTimeString`、`toLocale*`、数字构造函数、无偏移量字符串解析、`Date()` 函数调用，全部按出口 IP 时区（含 DST）计算 |
| Intl 时区 | 本机系统时区 | 出口 IP 对应时区（即使传入 locale 也注入） |
| navigator 语言 | 本机语言 | 根据国家码 + 时区推断 |
| 浏览器 / 设备品牌 | UA、UA-CH 中的国产浏览器标识和设备型号 | 显示普通 Chrome/Chromium 品牌，隐藏设备型号，并同步 `User-Agent` 与相关 Client Hints 请求头；按本次 Anthropic / Claude 或检测站访问的选择生效 |
| Intl 默认 locale | 本机 locale | `DateTimeFormat`/`NumberFormat`/`Collator`/`RelativeTimeFormat`/`PluralRules`/`ListFormat`/`DisplayNames`/`Segmenter`/`DurationFormat` + `Number`/`Array`/`BigInt.toLocaleString` 全部一致 |
| Accept-Language | 本机请求头语言，且仅主/子框架和 XHR 生效 | 修改已确认的 Anthropic 目标及两个检测站请求，覆盖**所有**资源类型（图片/字体/脚本/beacon 等） |
| WebRTC IP | 可能绕过代理泄露真实 IP | 仅在目标网站禁用 WebRTC 连接，其他网站保持默认；会影响本站依赖 WebRTC 的音视频功能 |
| 反检测 | `Function.prototype.toString` 可拆穿伪装，`data-notme` 属性残留在 DOM | 伪装函数对 `fn.toString()` 与 `Function.prototype.toString.call(fn)` 都显示 native；payload 改用 `window.postMessage` 传递，不写入 DOM；捕获后立即删除 `window.GeoMirrorTZ` 全局,页面无从探测 |
| **Anthropic 页面** | —— | 七个保护主域及所有子域先选择环境、检查网络，再确认访问；各项可单独选择伪装或系统默认 |

脚本在七个 Anthropic 主域及其子域、上述两个检测站运行。其他网站保持原生环境；Web Worker 伪装仍为可选功能，默认关闭。

WebRTC 保护仅在选定网站禁用连接，不再修改浏览器全局策略。

## 它具体做了什么

notme 会检测当前可见的 **出口 IP**，根据这个 IP 派生出一个合理的浏览器画像，然后在 Chrome 本地应用：

1. 伪装 HTML5 地理位置：`navigator.geolocation`（返回真正的 `GeolocationPosition`）
2. 伪装地理位置权限：`navigator.permissions.query({ name: "geolocation" })`（返回真正的 `PermissionStatus`）
3. 伪装整个 `Date` 本地时间面：`getTimezoneOffset` + 所有本地 getter/setter + `toString`/`toDateString`/`toTimeString` + `toLocale*` + 数字构造函数 + 无偏移量 `Date.parse` + `Date()` 函数调用
4. 伪装 Intl 默认时区：`Intl.DateTimeFormat().resolvedOptions().timeZone`
5. 伪装浏览器语言：`navigator.language` / `navigator.languages`
6. 伪装 Intl 默认 locale：`DateTimeFormat`/`NumberFormat`/`Collator`/`RelativeTimeFormat`/`PluralRules`/`ListFormat`/`DisplayNames`/`Segmenter`/`DurationFormat` 及 `Number`/`Array`/`BigInt.toLocaleString`
7. 伪装 HTTP 语言请求头：`Accept-Language`（覆盖所有资源类型）
8. 可选：仅在目标网站禁用 WebRTC 连接

目标很简单：如果你的 IP 看起来在东京，浏览器就不应该还像上海、洛杉矶或柏林 —— 而且任何一个 `Date` 或 `Intl` 调用都不应该悄悄出卖你。

## 隐私模型

notme 是 local-first、可审计的：

- 不需要账号。
- 没有 telemetry。
- 没有 analytics。
- 不读取网页正文内容。
- 没有远程配置。
- 设置和计算结果只保存在 `chrome.storage.local`。

需要说清楚的一点：notme 不是“零联网”扩展。要做到一键匹配当前出口 IP，它必须通过 Chrome 的网络栈请求 manifest 中明确列出的公共 IP/地图接口。这些请求只用于：

- 检测出口 IP 的位置；
- 查询出口 IP 附近住宅道路；
- 为弹窗显示做反地理编码。
- 检查目标 Anthropic 域名的 `/cdn-cgi/trace`，并查询该目标返回的出口 IP 的位置。

它不会上传页面内容或浏览历史。完整数据流见 [隐私政策](./PRIVACY.md) 和 [技术说明](./docs/TECHNICAL.md)。

## 工作原理

```mermaid
flowchart TD
  A["代理 / VPN / 远程出口"] --> B["网站看到的出口 IP"]
  B --> C["background.js<br/>检测 IP 地理位置 + 时区"]
  C --> D["lib/geo.js<br/>选择附近住宅道路坐标"]
  C --> E["lib/locale.js<br/>国家码 + 时区推断语言"]
  D --> F["chrome.storage.local<br/>保存 override"]
  E --> F
  F --> G["content-bridge.js<br/>隔离世界读取 storage"]
  G --> H["window.postMessage<br/>传递 JSON payload"]
  H --> I["content-inject.js<br/>MAIN world @ document_start"]
  I --> J["页面看到一致的<br/>定位 / 时区 / 语言 / 请求头"]
```

技术链路：

1. `background.js` 通过多个 provider 检测当前出口 IP。
2. `lib/providers.js` 统一解析 IP、国家码、经纬度、ISP、IANA 时区等字段。
3. `lib/geo.js` 使用 OpenStreetMap / Overpass 在附近选择住宅感坐标。
4. `lib/locale.js` 根据国家码 + 时区推断 locale bundle。
5. `background.js` 把 override 存入 `chrome.storage.local`，并安装动态 `Accept-Language` 规则。
6. `content-bridge.js` 在 isolated world 中读取 extension storage，通过 `window.postMessage` 把 payload 发送到 MAIN world。
7. `content-inject.js` 在 MAIN world 的 `document_start` 阶段读取 payload，并覆盖页面可见 API。

## 安装

### 方式 A：加载未打包扩展（Chrome / Brave / 任意 Chromium）

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`。
3. 开启右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**。
5. 选择 `notme` 文件夹。
6. 固定 notme，点击图标打开环境页面，需要时点击 **刷新环境**。

### 方式 B：加载未打包扩展（Microsoft Edge）

notme 是标准的 Chromium MV3 扩展，Edge 的加载方式完全相同：

1. 下载或克隆本仓库。
2. 在地址栏输入并打开 `edge://extensions`。
3. 打开左下角的 **开发人员模式 / Developer mode**。
4. 点击 **加载解压缩的扩展 / Load unpacked**。
5. 选择 `notme` 文件夹（即包含 `manifest.json` 的那个目录）。
6. 从工具栏拼图图标里固定 notme，点击图标打开环境页面，需要时点击 **刷新环境**。

Edge 支持 notme 用到的所有 `chrome.*` API（`declarativeNetRequest`、`alarms`、`privacy`），因此全部功能都可正常工作。如果环境页面显示错误，先确认代理/VPN 已连接，再点一次 **刷新环境**。

### 方式 C：Chrome 应用商店 / Edge 加载项

计划后续上架。在此之前请使用未打包扩展。

### 更新未打包扩展

从 1.8.1 起，manifest 内包含固定公钥，扩展 ID 固定为 `jnppijkakhomofmffakonooanpggmoff`，不再随目录路径变化。后续版本保持这份公钥不变。更新时可以覆盖原目录并点重新加载，也可以在同一浏览器配置中加载新的解压目录；扩展 ID 和本地设置保持不变。新目录需要保留在磁盘上。

从 1.8.0 或更早版本升级时，先停用旧的那份，再加载 1.8.1。旧版使用目录生成的 ID，这次会更换一次 ID，旧设置不会自动迁移，需要在新版重新设置一次。后续更新不再需要重复配置。发布包仅包含公钥，扩展运行不需要私钥。

## 验证效果

在已确认的 Anthropic 页面控制台检查这些值；上述两个检测站按本次确认的配置伪装，其他检测站显示系统原生环境：

```js
navigator.language
navigator.languages
Intl.DateTimeFormat().resolvedOptions()
new Date().getTimezoneOffset()
navigator.geolocation.getCurrentPosition(console.log, console.error)
```

再打开 DevTools → Network → 请求头，确认 `Accept-Language` 与伪装后的语言一致。

可用检测页面：

- https://browserleaks.com/geo
- https://browserleaks.com/javascript
- https://browserleaks.com/headers

## 设置项

地理位置默认 **不提供位置**：拒绝网页定位请求，不查询住宅街道或反向地址。需要定位时可手动选择 **伪装** 或 **系统默认**。IP 地区服务改为并行查询，每组最多等待四秒（包括响应正文），期间发现的限制地区结果都会保留。检查页显示当前阶段和累计耗时。

- **Location spoof**：启用/关闭地理位置伪装。
- **Timezone spoof**：启用/关闭 `Date` 和 `Intl` 时区伪装。
- **Language spoof**：启用/关闭 `navigator.language(s)`、Intl locale、`Accept-Language`。
- **浏览器与设备标识**：按本次 Anthropic / Claude 或检测站访问的选择，伪装 UA、UA-CH、设备型号和对应请求头。
- **IP 防泄漏（WebRTC）**：仅在本站禁用 WebRTC 连接，默认开启；选择系统默认可使用原生 WebRTC。会影响本站依赖 WebRTC 的音视频功能，其他网站不受影响。
- **Hide CJK fonts**：把暴露操作系统/地区的中文字体(微软雅黑、苹方、宋体、黑体…简繁都含)从 canvas `measureText` 和 DOM 宽度探测里剥掉，让它们读起来像"未安装"。默认开启。
- **Spoof in Web Workers（实验性）**：把时区/语言伪装扩展到专用 Web Worker(指纹站常在 worker 里读真实时区来绕过主线程伪装)。**默认关闭** —— 它通过 blob 垫片重新加载 worker 代码,可能破坏依赖 `self.location` 的 WASM/打包 worker。它会探测 CSP 是否允许 `blob:`,被拦时回退到原生 worker(不会静默弄坏 worker),但请仅在你确实需要 worker 级时区隐藏时开启;某站点 worker 出问题就关掉它。
- **Force timezone（强制时区）**：选一个时区就会**完全覆盖出口 IP 探测** —— 时区、语言、代表坐标都强制用你选的这个,不管出口 IP 探测到哪里、也不管探测是否成功。用它来呈现一个固定的非中国环境。留在 *Auto — use exit IP* 则跟随探测到的出口 IP。（选一个后立即生效。）**注意:** 强制一个和你真实出口 IP 不一致的时区,只能骗过**浏览器侧**的检测(例如 Anthropic 页面读取 `Intl` 时区);如果对方在**服务器端读你的出口 IP** 再和浏览器时区比对,仍会看到 IP↔时区不一致 —— 那种情况唯一的真正解法是用一个真的从目标地区出口的代理。
- **Accuracy (m)**：上报给页面的定位精度，默认 30 米。
- **Refresh (min)**：重新检测出口 IP 的间隔。
- **ipinfo.io token（可选）**：有 token 时可提升 fallback 稳定性。

## Claude Code（终端）：另一条独立的时区通道

上面的浏览器扩展伪装的是**浏览器**时区。**Claude Code** 终端是另一个进程,它报告的是**操作系统时区**(通过 `TZ` 环境变量)—— 浏览器扩展**碰不到它**。要让 Claude Code 呈现美国时区,用 [`tools/claude-tz/`](./tools/claude-tz/) 里的脚本装一个 `claude` 包装器:

```bash
cd tools/claude-tz && bash install.sh          # macOS / Linux / WSL（zsh/bash/fish）
# Windows PowerShell:  powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它只包装 `claude` 这一个命令,不影响你 shell 里的其他东西。逐个 shell 的手动写法、其它美国时区、以及重要提醒(它只改"报告的时区",改不了你的出口 IP)见 [tools/claude-tz/README.md](./tools/claude-tz/README.md)。你需要哪条通道:

| 你用 | 时区来自 | 用什么修 |
| --- | --- | --- |
| claude.ai 网页 / 指纹检测 | **浏览器** | notme 扩展（*Force timezone*） |
| Claude Code **终端** | 操作系统 **`TZ`** | `tools/claude-tz/` |

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 本地保存设置与计算出的 override。 |
| `alarms` | 定时刷新出口 IP。 |
| `declarativeNetRequest` | 设置 outgoing `Accept-Language`、`User-Agent` 和身份 Client Hints 请求头，不读取请求正文。 |
| `privacy` | 读取现有策略用于 UDP 诊断，并释放旧版留下的浏览器全局 WebRTC 控制。新保护仅在目标页面生效。 |
| 限定站点的内容脚本 | 在七个保护主域及子域、指定的两个检测站和继承其 origin 的框架中应用所选环境。 |
| 限定的主机权限 | 仅访问 Anthropic 目标、指定的两个检测站和已列出的诊断服务。 |

## 如果你不想安装这个扩展

可以把下面这段提示词复制给自己的 Agent，让它为你生成一个本地版本：

```text
请构建一个 Chrome Manifest V3 扩展，用于让浏览器可见的地区画像与当前出口 IP 保持一致。

要求：
1. 通过 Chrome 网络栈检测浏览器当前可见出口 IP，使用多个 IP geolocation provider 做 fallback。
2. 保留 provider 返回的国家码、城市/地区/国家、经纬度、ISP、IANA timezone。
3. 不要直接使用 IP 中心点；优先用 OpenStreetMap Overpass 查询附近 highway=residential 住宅道路，并选择一个合理坐标；失败时使用安全 jitter fallback。
4. 根据国家码 + timezone 推断 locale bundle，包括 navigator.language、navigator.languages、Accept-Language。
5. 所有设置和计算出的 override 只存 chrome.storage.local。不要 telemetry，不要 analytics，不要账号系统，不要远程配置，不要收集网页内容。
6. 使用两个 content script：
   - isolated-world bridge：读取 chrome.storage，把 JSON payload 发布到 DOM；
   - MAIN-world injector：document_start 执行，patch 页面可见 API。
7. patch 以下内容：
   - navigator.geolocation.getCurrentPosition / watchPosition / clearWatch
   - navigator.permissions.query 的 geolocation 结果
   - Date.prototype.getTimezoneOffset，要求使用调用者 Date 实例，并支持 DST-aware IANA timezone
   - Intl.DateTimeFormat 默认 timezone 和 resolvedOptions().timeZone
   - navigator.language 和 navigator.languages
   - Intl.DateTimeFormat / Intl.NumberFormat / Intl.Collator 默认 locale
8. 使用 chrome.declarativeNetRequest 在 language spoof 开启时设置 outgoing Accept-Language header。
9. 工具栏和访问前检查共用中文环境页面，逐项选择伪装或系统默认；时区直接选择，其余参数放在折叠的高级设置中。
10. 添加测试，覆盖 timezone DST offset、locale 推断、provider parsing、manifest 注入顺序。
11. 写清楚隐私模型：无 telemetry，不读取页面内容，只本地存储；外部请求仅用于出口 IP / 地理位置匹配。
```

## v1.2 修复了什么

这些在旧版本中都是真实存在的漏洞，现已修复：

- **`Date` 自相矛盾**：旧版只伪装了 `getTimezoneOffset()` 和 `Intl.DateTimeFormat`，`new Date().getHours()`、`.toString()`（会显示 `… GMT+0800 (China Standard Time)`）、`.toLocaleString()`、`Number.prototype.toLocaleString` 以及大部分 `Intl.*` 仍然泄露本机时区/语言 —— 一行交叉校验就能拆穿。现在整个 `Date` 本地时间面和所有与 locale 相关的 `Intl` 构造函数都按出口 IP 时区计算。
- **`Accept-Language` 实际没生效**：`declarativeNetRequest` 的 `modifyHeaders` 需要对访问站点的主机权限，而旧 manifest 只列了 IP 接口域名，所以规则在真实网站上被跳过。现在主机权限限定在 Anthropic、两个检测站和诊断服务，且规则覆盖**所有**资源类型（旧版只覆盖主/子框架和 XHR，图片/字体/脚本/beacon 仍泄露真实语言）。
- **`Intl.DateTimeFormat` 丢弃时区**：无 locale 路径存在一个位置参数 bug，导致仅开时区伪装、关语言伪装时泄露本机时区。已修复。
- **WebRTC 可能绕过代理泄露真实 IP**：现在按所选配置在 Anthropic 页面和两个检测站禁用 WebRTC 连接。
- **反检测**：`Function.prototype.toString.call(fn)` 曾会返回 wrapper 源码；payload 曾以 `<html data-notme>` 明文留在 DOM；`permissions.query` 曾返回普通对象。均已修复。
- **不透明来源框架**：`about:blank` / `srcdoc` / `data:` / `blob:` 子框架现在也会被 patch（`match_origin_as_fallback`）。

## 局限（如实说明）

- notme 提升位置/时区/语言和浏览器/设备信号的一致性，**不是**完整反指纹系统。Canvas 像素、WebGL、音频和屏幕信息没有修改；字体保护只覆盖宽度探测。浏览器/设备伪装覆盖页面 API 和身份请求头，不改变真实浏览器内核、硬件、TLS 指纹或 Worker 内的 JavaScript 品牌信息。
- IP 地理位置本身是近似值；住宅坐标是附近的合理点，不是你的真实地址。
- 语言推断是启发式的，因为 IP provider 不知道用户真实语言。
- **Worker 覆盖是部分的。** 经典专用 Web Worker 现在会被伪装(通过 "Spoof in Web Workers" 开关),但 **Shared Worker、Service Worker、Worklet 以及模块(module)worker 仍读取本机时区/语言** —— 内容脚本无法在不破坏它们的前提下 patch 这些作用域。
- **字体隐藏只针对宽度探测。** 覆盖 canvas `measureText` 和 DOM 元素宽度;不改 canvas **像素**读取(`toDataURL`/`getImageData`)指纹,也不覆盖用 CSS 类(而非内联 style)设置字体的探测。
- 浏览器扩展无法注入 `chrome://` / `edge://`、扩展商店等特权页面。
- 平台可能使用浏览器 JS 和请求头以外的其他信号（TLS/HTTP 指纹、账号历史、行为信号），这些扩展无法改变。

## 开发

项目结构：

```text
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

检查命令：

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

改动后，在 `chrome://extensions` 点击扩展卡片上的刷新图标重新加载。

## 许可证

[MIT](./LICENSE)

