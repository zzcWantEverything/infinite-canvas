# 项目长期记忆 · 画柚 / infinite-canvas

> 日常流水写 `YYYY-MM-DD.md`；这里只放跨会话仍然成立的结构、约定与坑。

## 技术栈与结构

- 前端 `web/`：Vite 7 + React 19 + React Router 7 + TypeScript + Ant Design 6 + Tailwind 4 + Zustand 5，包管理用 bun。
- 不是全站 i18n：`i18n/locales/*` 只覆盖部分 UI，登录页等仍是硬编码中文；新增文案先查现有 key 再加。
- 本地 Agent `canvas-agent/`（独立 npm 包，Node + express + zod，CLI 是 `@openai/codex`）；`canvas-proxy/` 是纯转发工具；`plugins/` 是节点插件与 Codex app 插件。
- 无后端、无 BFF：API Key 与画布数据都在浏览器本地（localforage / IndexedDB），请求由前端直连 OpenAI 兼容接口。
- 无 ESLint；测试只有 `canvas-agent` 的 8 个用例 + `web/tests/image-thumbnail.test.ts`；CI 只跑 `vite build`（不做类型检查）。

## 请求层约定（2026-11 起）

- 所有请求错误统一走 `web/src/services/api/http.ts`：`ApiError { kind, status }` + 全局 axios 拦截器。**不要再在业务模块里复制 `readApiErrorMessage` / `readAxiosError`**，直接 import。
- 业务里需要给用户提示的失败用 `reportApiError`；同一文案 2 秒去重。生成类流程不要弹 toast（节点自身展示错误）。
- 拦截器对取消请求**原样放行**（`axios.isCancel` 提前 return），否则会破坏画布 `AbortError` 的静默取消语义。改这段前先确认 `lib/canvas/canvas-generation-helpers.ts` 的取消判定。
- 依赖登录态的接口必须加 `requiresAuth: true`（模块增强字段），否则 401 不会触发登出。目前只在 `auth.ts` 的 6 个用户态接口上标。
- 登录态：后端无 refresh token（New API 风格），只做「启动校验 + 401/`success:false` 清会话重登录」。跳转由 `AuthGuard` 自动完成，**不要手写 navigate**。
- **上游错误脱敏**：`lib/upstream-error.ts` 的 `humanizeUpstreamError()` 命中「渠道不可用 / 当前可用渠道 / channel 可传渠道 / not served by this plugin」就整段替换成「该模型当前线路不可用」，收敛在 `http.ts` 的 `toApiError` / `readAxiosError`（toast、节点、失败卡片全覆盖），画布老节点的 `errorDetails` 渲染时再兜一次。自家后端文案（余额不足等）不匹配这些词、原样透出。

## 模型目录与模型选择（2026-11 起）

- 模型目录 `/api/user/models/catalog`（`services/api/model-catalog.ts`）：模块级缓存 + 5min TTL，登录后 `AuthGuard` 拉一次。
  读缓存用 `catalogVariant(name)` / `catalogGroupOf(name)`，版本通知用 `modelCatalogVersion()`（`useSyncExternalStore(subscribeModelCatalog, ...)`）。
  **能力 / 展示名 / billingUnit 的唯一来源是目录**，不要凭模型名猜。
- 视频节点模型列表 = `/api/user/models`（`fetchUserVideoModels`）再用 `isVideoModel()` 过滤（`model-picker.tsx`）：
  目录 `capabilities.modality.output` 含 `video` 才是视频；目录没拉到先保留；目录有模型但没 output（手动加的 GPT 生图渠道）退回 `guessCapability` 关键词。
  图片节点走 `selectableModelsByCapability(config, "image")`（渠道 capability 标签过滤）。
- 计价单位 = `catalogVariant(name).capabilities.billingUnit`（`second`/`request`）。不要用「1 秒和 2 秒是否同价」启发式——阶梯起步价（如 ≤5 秒一口价、之后按秒）会误判成按次。
- 展示名格式「组名 · 型号 分辨率[ 按秒]」，`model-picker-groups.ts` 按 `" · "` 切成「组标题 + 线路名」，没 ` · ` 就整串当名字。

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
