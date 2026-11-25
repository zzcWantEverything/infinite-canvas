# 项目长期记忆 · 画柚 / infinite-canvas

> 日常流水写 `YYYY-MM-DD.md`；这里只放跨会话仍然成立的结构、约定与坑。
> **路径约定**：项目内文件相对**本项目根目录**写；兄弟项目写 `../<项目名>`（两个项目在本地始终是同级目录，别管父目录叫什么）；服务器路径 `/home/ubuntu/...` 保持绝对（与本地机器无关）；本机环境（`~/.ssh`、Go 安装目录）标注「本机」。**不要写带盘符的绝对路径**——上级目录被挪过（`E:\product\huayou` → `E:\p` → `E:\huayou`），写死一次就前功尽弃。
> 跨项目（两个前端别发串、服务器与部署入口）见 `../new-api/.workbuddy/memory/MEMORY.md`。

## 技术栈与结构

- 前端 `web/`：Vite 7 + React 19 + React Router 7 + TypeScript + Ant Design 6 + Tailwind 4 + Zustand 5，包管理用 bun。
- 不是全站 i18n：`i18n/locales/*` 只覆盖部分 UI，登录页等仍是硬编码中文；新增文案先查现有 key 再加。
- 本地 Agent `canvas-agent/`（独立 npm 包，Node + express + zod，CLI 是 `@openai/codex`）；`canvas-proxy/` 是纯转发工具；`plugins/` 是节点插件与 Codex app 插件。
- 主链路无 BFF，但**不是纯前端项目**：API Key 与画布/项目数据仍在浏览器本地（localforage / IndexedDB），图片视频生成由前端直连 OpenAI 兼容接口；而 /copy 的分析与转写、画布云存储（`/api/canvas/*`）、模型目录（`/api/user/models/catalog`）、钱包日志（`/api/log/self`）都走 new-api 服务端。
- 无 ESLint；测试只有 `canvas-agent` 的 8 个用例 + `web/tests/image-thumbnail.test.ts`；CI 里 `github-pages.yml` 只在 `v*` tag 上跑 `bun install && bun run build`（不跑 tsc/test），另有插件发布与两个 docker 镜像 workflow。

## 请求层约定（2026-11 起）

- 所有请求错误统一走 `web/src/services/api/http.ts`：`ApiError { kind, status }` + 全局 axios 拦截器。**不要再在业务模块里复制 `readApiErrorMessage` / `readAxiosError`**，直接 import。
- 业务里需要给用户提示的失败用 `reportApiError`；同一文案 2 秒去重。生成类流程不要弹 toast（节点自身展示错误）。
- 拦截器对取消请求**原样放行**（`axios.isCancel` 提前 return），否则会破坏画布 `AbortError` 的静默取消语义。改这段前先确认 `lib/canvas/canvas-generation-helpers.ts` 的取消判定。
- 依赖登录态的接口必须加 `requiresAuth: true`（模块增强字段），否则 401 不会触发续期/登出。现已标在 `auth.ts`（7 处：登录、注册、改密、兑换码、邀请码等）、`logs.ts`、`model-catalog.ts`、`canvas-cloud.ts`（含媒体 presign）。
- 登录态：access token 只有 15 分钟，new-api 用 HttpOnly cookie（`new_api_refresh`，`Path=/api/user/auth`）续期且 token 会轮转。`session.ts` 负责单飞续期（最小间隔 10s、429 退避 30s），`http.ts` 在 401 时续期并**重放一次**请求，续不上才清会话重登录；`success:false` 也要按同一套处理。跳转由 `AuthGuard` 自动完成，**不要手写 navigate**。
- **上游错误脱敏（2026-11-24 改成白名单式）**：`lib/upstream-error.ts` 的 `humanizeUpstreamError()` 按顺序判：HTML 错误页 → 图片编号超界 → **价格**（货币符号+数字、`\d+ 元/积分`、倍率/单价/计费、price/billing/credit）→ 审核 → 超时 → 繁忙 → 参数不支持 → 上游内部标记（channel #、status_code、`"detail"`、curl、上游/渠道号）或超 160 字。命中就整段替换成固定说法，**价格绝不出现在前端**；只有我们自己后端的短文案（如「用户额度不足」）原样透出。
  任务失败原因也走同一套：`http.ts` 的 `readFailureMessage(value, fallback)`，`video.ts` 里不要再直接用 `readApiErrorMessage(...) || 兜底`。节点 `errorDetails` 渲染时再兜一次。

## 模型目录与模型选择（2026-11 起）

- 模型目录 `/api/user/models/catalog`（`services/api/model-catalog.ts`）：模块级缓存 + 5min TTL，登录后 `AuthGuard` 拉一次。
  读缓存用 `catalogVariant(name)` / `catalogGroupOf(name)`，版本通知用 `modelCatalogVersion()`（`useSyncExternalStore(subscribeModelCatalog, ...)`）。
  **能力 / 展示名 / billingUnit 的唯一来源是目录**，不要凭模型名猜。
- 视频节点模型列表 = `/api/user/models`（`fetchUserModels`，不是 `fetchUserVideoModels`）再用 `isVideoModel()` 过滤（`model-picker.tsx`）：
  目录 `capabilities.modality.output` 含 `video` 才是视频；目录没拉到先保留；目录有模型但没 output（手动加的 GPT 生图渠道）退回 `guessCapability` 关键词。
  图片节点走 `selectableModelsByCapability(config, "image")`（渠道 capability 标签过滤）。
- 计价单位 = `catalogVariant(name).capabilities.billingUnit`（`second`/`request`）。不要用「1 秒和 2 秒是否同价」启发式——阶梯起步价（如 ≤5 秒一口价、之后按秒）会误判成按次。
- 展示名格式「组名 · 型号 分辨率[ 按秒]」，`model-picker-groups.ts` 按 `" · "` 切成「组标题 + 线路名」，没 ` · ` 就整串当名字。
- **模型下拉的分组覆盖**：`model-picker-groups.ts` 的 `MODEL_GROUP_OVERRIDES`（按模型 id 指定分组名），灵境那 8 个档位统一归到「特惠优选」。只影响展示，取值仍是 `渠道::模型名`。别改成按「特惠版」前缀匹配——老 miniKey 渠道也有同名模型，会被误吸进来。
- **分档价差大的模型选中即落默认档**：`videoModelDefaultResolution(model)` 指定默认档（如特惠按秒款 480P），`applyNodeConfigPatch` / store 的 `updateConfig("videoModel")` 会把 `vquality` 与 `size` 一起落档；下拉报价也按这一档报。只在面板 effect 里落档不够——旧节点已有 `vquality` 时不会触发。

## 图片生成（2026-11-24）

- **参数按模型分流**：上游只有 `tt-image-2` 收 `size + quality`，`tt-image-2.5/2.6/banana` 系列只认 `aspectRatio + imageSize`。画柚走 OpenAI 图片协议只发 `size`，换算在网关插件里做（minikey 1.4.10）；**不要在前端按模型名拼 aspectRatio**。
- **比例选项按能力渲染**：`image-settings-panel.tsx` 从 `catalogVariant(model).capabilities.fields.ratio.enum` 取可选比例，没声明才退回香蕉系写死列表。上游是**按线路**限制的（同一模型换条线路限制就不同），只能信目录，不能按模型名猜。
- **清晰度只有 1K**：上游目前只开 1K 档，`AVAILABLE_IMAGE_SCALES = ["1k", "auto"]`；以后开放 2K/4K 把值加回数组即可。
- **1k 预设要压在 150 万像素内**：`imageSizePresets["1k"]` 的 2:3 / 3:2 / 21:9 / 9:21 改成 `960x1440` / `1440x960` / `1680x720` / `720x1680`，否则上游按 2K 计费、界面却写 1k。
- **默认比例 16:9**：`defaultConfig.size = "16:9"`；`persist` 的 `version: 1` + `migrate` 只把旧默认值 `1:1` 升上来，用户显式选过的不动。已有画布图片节点的比例存在节点元数据里，不会跟着变。
- **提示词引用编号本地校验**：`lib/image-reference-prompt.ts` 的 `maxImageReferenceIndex()` 识别 `图片N` / `图N` / `Image N`（>100 当噪声），`createVideoGenerationTask` 派发前比对 `min(附件数, 模型 maxImages)`，超界直接报错——上游对越界请求回 502 并附一段 curl 教程。

## 画布交互（2026-11 中）

- **新建节点菜单**：右键空白画布触发（`preventCanvasContextMenu` 里 `setNodeCreatePosition`）；双击空白只关菜单。选择参考图模式下右键不弹。
- **拖入图片**：节点统一成视频比例（横 16:9 / 竖 9:16，`nodeSizeFromRatio`），内容 `object-contain`；不再按图片原始宽高比浮动。
- **云存储前端**（`8b44fd9` 已发布）：`canvas-cloud.ts`（/api/canvas/* + COS 预签名直传、签名回放）、
  `canvas-cloud-sync.ts`（项目 push/pull，本地 id↔云端 uuid 映射，冲突以服务端为准）、`file-storage`/`image-storage`
  （本地 blob 秒回显 + fire-and-forget 传云，objectKey 映射存 localforage）。后端对应 new-api `/api/canvas/*`（`cc75bc8f9` 已上线）。

## 画布渲染约定

- `InfiniteCanvas` 的 children 全在 `translate(x,y) scale(k)` 世界层里。**跟随视口的状态提示、浮层必须作为它的兄弟节点渲染**，写进 children 会被带偏压窄（曾出现提示跑到原点并变成竖排）。
- 视口层参照的是 `<section class="relative">`，顶栏 `h-16`，提示类浮层常用 `top-[72px]`。

## 已知问题（暂未修）

- `npx tsc --noEmit` 有 2 个历史错误：`components/layout/model-script-editor.tsx:58`（Modal styles 类型）、`stores/use-user-store.ts:37`（persist storage 转换）。改动这两个文件时注意别被误认为新引入。
- `/api/user/models` 会返回能力表未登记的模型（如 qr-v024/025/026/027/028/032/038），列表显示裸名，且生成会 fallback 到 OpenAI 协议。等后端确认返回策略，**不要凭空补 `videoModelCapabilities`**（价格/能力编错会直接生成失败）。

## 开发陷阱

- **接口地址不要写死**：`use-config-store.ts` 的默认 baseUrl 是 `siteOrigin()`（跟随当前站点），启动时 `normalizeBaseUrl()` 会把「同机不同端口/本机地址/http-IP 遇 https 站点」的历史配置改成当前 origin。不要再把服务器 IP 写回默认值；外部域名地址必须保留，Gemini 官方和第三方中转本来就要跨域。
- **非安全上下文**：`crypto.subtle`、`navigator.clipboard`、`crypto.randomUUID` 只在 HTTPS 或 localhost 可用；用 `http://` + 局域网/公网 IP 访问时它们都是 undefined。哈希统一用 `lib/hash.ts` 的 `sha256Hex()`（内部回退 `@noble/hashes`），不要直接调 `crypto.subtle`。
- 本机没有 bun（`bun: command not found`），装包用 `npm install <pkg> --legacy-peer-deps`：`@ant-design/pro-components@3.0.0-beta.3` 的 peer 要 antd 5，项目是 antd 6，不加这个参数会 ERESOLVE 失败。装完 `bun.lock` 不会更新，需要用户自己跑一次 `bun install` 同步。
- `prettier --write` 前先确认目标文件在 HEAD 是否 prettier-clean（对比 `git show HEAD:web/<path>`），不 clean 就不要整体格式化，否则 diff 全是噪音。`auth.ts` 踩过。
- 仓库 `core.autocrlf=true`，工作区里一部分文件本身就是 CRLF（`canvas-top-bar.tsx`、`canvas-node.tsx` 等），对这些文件跑 `prettier --check` 会整篇报格式错误，这是环境问题不是代码问题。判断有没有引入格式问题看 `git diff --numstat` 行数，别顺手 `--write`（会把整份文件换行都改掉）。
- 同一个文件别分两次改「调用点」和「import」：HMR 会把中间态推给浏览器，表现为 `xxx is not defined`。一次编辑写完两者。
- Vite 样式/模块不更新：`rm -rf node_modules/.vite` 后重启 + 强制刷新。
- 改了 `VERSION` / `CHANGELOG.md` 会被 `vite.config.ts` 读进 `__APP_VERSION__` / `__APP_RELEASES__`，需要重启 dev。

## 校验

```
cd web && npx tsc --noEmit          # 类型（允许上述 2 个历史错误）
cd web && npx prettier --check <file>
```

## 发布（单机，2026-11-14 补）

- 部署脚本在 **`/home/ubuntu/new-api/`**（不在 `~`）：`./deploy-huayou.sh <dist目录|tgz>`、`./rollback.sh web`。
- `:443` 与 `:80` 由 nginx 指到 `/home/ubuntu/dist` → 软链 `/home/ubuntu/releases/web/<时间戳>/`；
  脚本切软链后自检首页，只保留最近 5 个版本。
- 走 tgz 时包内可以裹一层目录，脚本会自己找 `index.html` 所在层提上来；找不到就中止且不动线上。
- 校验线上 assets 必须带 `-A 'Mozilla/5.0'`：nginx 对空 UA 返 403，会误判成发布失败。
- 2026-11-23 实测：`VERSION` 仍停在 `v0.20.1`（此后只切 `releases/web/<时间戳>`、没再升版本号），线上指向 `releases/web/20261121-131023`，首页 `<title>画柚</title>`、主包 `index-DnYTZ0o7.js`。

## 爆款转绘 /copy（2026-11-18）

- **入口**：侧栏「复刻视频」（`slug: "copy"`，`constant/navigation-tools.ts`）+ 路由 `/copy`。
  **2026-11-19 起线上常显**：去掉了 `import.meta.env.DEV` 过滤，侧栏与移动抽屉直接 `navigationTools.map`。
- **流程**（`pages/copy/index.tsx` + `services/api/copy-video.ts`）：
  1. 上传视频（≤150MB，**≤10 分钟**，超时直接拒绝）
  2. `extractSceneFrames`：纯 canvas 场景检测——采样步长 ≤60s **0.2s** / ≤5min 0.5s / 其余 1s；切点 =
     16 档直方图差分 + 逐像素差分（硬切 `pixel≥0.1 || hist≥0.3`，叠化看连续 ≥3 个软信号）；
     **选帧 = 每秒一帧 + 末帧 + 每个切点首帧**，上限 32 帧（每帧 640 长边）
  3. `buildFrameGrid`：按视频真实比例排版（1400×1568 预算内选单格面积最大的列数），标 `#序号 时间`；
     横屏 32 帧≈4 列 316×177，竖屏≈8 列 175×311（之前固定 200×112 的 16:9 格，竖屏白丢一半像素）
  3.5 `groupFramesIntoBatches`：按场景分批（≤10 镜 / ≤16 帧），串行请求，后一批带「已确认清单」；`mergeBatchAnalyses` 合并
  4. `extractAudioWav`：`AudioContext.decodeAudioData` + `OfflineAudioContext` 重采样 16kHz 单声道、手写 WAV 编码
     （**不装 ffmpeg**；HEVC/AC3 等浏览器不认的编码返回 null 降级）
  5. `transcribeAudio`：调 new-api `POST /api/user/copy/transcribe`（腾讯云 ASR 代理，**用 session token 不是渠道 apiKey**），拿带时间戳台词
  6. `analyzeVideoGrid`：宫格图 + 元数据 + 台词一起给 `gpt-6-sol`，输出角色/场景/物品 + 分镜（分镜含 `dialogue` 字段）。
     **接口是异步的**：`POST /api/user/copy/analyze` 只收 `{model, prompt, image}`（**不收 apiKey / baseUrl**），返回 jobId 后按 `GET /api/user/copy/analyze/:id` 每 2s 轮询；令牌由服务端自己从 `tokens` 表取、地址固定 loopback，用来规避链路 120s 代理超时。
- **模型调用必须走 `resolveModelRequestConfig`**：登录模式顶层 `config.apiKey` 是空的，真正可用的 relay key 在渠道上
  （启动时 `resolveRelayApiKey` 用 session token 换好）。直接读顶层 apiKey 会 401「无效的令牌」。
- **图片节点的模型回显**（2026-11-18 修）：`resolveModelForCapability` 只在本地 `config.channels` 里匹配，服务器目录里的图片模型
  不在其中，会被判不可用退回默认——表现是「选了不回显、生成还是旧模型」。已在 `stores/use-config-store.ts` 对 `capability === "image"`
  放行 `currentModel`，并让 `buildNodeConfig` / 图片 ModelPicker 的 value 优先用 `node.metadata.model`。
- **隐藏的入口**（2026-11-18）：「配置」全链路下线——侧栏/移动端抽屉入口移除、`/config` 重定向首页、
  `app-top-nav` 不再渲染 `AppConfigModal`、SSO 导入后不再弹配置、首页灵感空态的「去配置」按钮移除。
  `pages/config` 文件保留（恢复只需改回路由）。
- **灵感广场已移除**：首页不再拉 `fetchPrompts`，只保留创作入口（标题+输入框+模式切换+建议词）。

## /copy 与云同步的坑（2026-11-20 ~ 11-21）

- **item id 必须带分区前缀**：`normalizeAnalysis` 里 `toItems` 对 roles/scenes/items 各调一次，
  用 `item-<stamp>-<index>` 会让三个分区的第 0 项同 id → 一张图同时显示在三处、批量生图互相覆盖。
  现为 `${section}-${stamp}-${index}`；老历史记录载入时走 `sanitizeItemIds()` 重写 + 素材键迁移。
- **云端保存有两个静默失败点**：`pushProjectToCloud` 的 `catch {}` 吞掉所有错误（现在写 `useCanvasSyncStore`，
  画布右下角显示「未同步到云端 · 重试」）；1.5s 防抖会被视频任务轮询（1~2 秒一次节点更新）无限重置
  （现在 `lastCloudPushAtRef` 兜底，10 秒必推一次）。
- **保存 effect 不能看 `historyPausedRef`**：那是撤销历史的标记，拖拽没收尾会永久 true，导致保存全程 no-op。
- **导入画布要补传素材**：zip 里只有本地键，`importCanvas` 必须 `uploadImportedAssets()` → `importProject()`
  → `pushProjectToCloud()`，顺序不能反（serializeDoc 要先拿得到 object_key）。
- **mediaPending 文案曾撒谎**：`videoMediaPending` 写着「稍后自动重试」但没有重试代码，
  现在每 12 秒扫一次、指数退避最多 5 次，耗尽后改提示让用户手点「查询进度」。
- 生成比例默认 **16:9**（图片/视频都是），分析完不再用原片比例覆盖。

## 图片任务化（2026-11-25）

- 图片生成已改成「网关任务」：`POST /v1/tasks/minikey` 提交拿 `task_id`，`GET /api/task/self?task_id=` 查状态，`GET /api/task/{id}/artifacts` 取图。**不要用 `/v1/tasks/{id}`**——它走 TokenAuth，页面里没有 sk- 令牌，会一直 401，表现为「上游成功但界面一直生成中」。
- task id 的落法照抄视频：写进节点 `metadata.imageTaskId` + `forceCloudPushRef` 立刻落盘 + 骨架里 10 秒兜底扫描续查。**不要**再把 id 存在队列或观察者里（都试过，会因为找不到目标节点而失效）。
- 参考图内联成 Base64 Data URL 传 `params.images`；上游 `banana` 分组临时下线时会 100% 失败，与代码无关。
- 构建自检：改了源码后先在 `dist/assets/index-*.js` 里 grep 新增字符串；hash 不变 = 改动没编进去。
