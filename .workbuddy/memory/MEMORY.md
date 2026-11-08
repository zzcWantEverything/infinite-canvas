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

## 画布渲染约定

- `InfiniteCanvas` 的 children 全在 `translate(x,y) scale(k)` 世界层里。**跟随视口的状态提示、浮层必须作为它的兄弟节点渲染**，写进 children 会被带偏压窄（曾出现提示跑到原点并变成竖排）。
- 视口层参照的是 `<section class="relative">`，顶栏 `h-16`，提示类浮层常用 `top-[72px]`。

## 已知问题（暂未修）

- `npx tsc --noEmit` 有 2 个历史错误：`components/layout/model-script-editor.tsx:58`（Modal styles 类型）、`stores/use-user-store.ts:37`（persist storage 转换）。改动这两个文件时注意别被误认为新引入。
- `/api/user/models` 会返回能力表未登记的模型（如 qr-v024/025/026/027/028/032/038），列表显示裸名，且生成会 fallback 到 OpenAI 协议。等后端确认返回策略，**不要凭空补 `videoModelCapabilities`**（价格/能力编错会直接生成失败）。

## 开发陷阱

- `prettier --write` 前先确认目标文件在 HEAD 是否 prettier-clean（对比 `git show HEAD:web/<path>`），不 clean 就不要整体格式化，否则 diff 全是噪音。`auth.ts` 踩过。
- 同一个文件别分两次改「调用点」和「import」：HMR 会把中间态推给浏览器，表现为 `xxx is not defined`。一次编辑写完两者。
- Vite 样式/模块不更新：`rm -rf node_modules/.vite` 后重启 + 强制刷新。
- 改了 `VERSION` / `CHANGELOG.md` 会被 `vite.config.ts` 读进 `__APP_VERSION__` / `__APP_RELEASES__`，需要重启 dev。

## 校验

```
cd web && npx tsc --noEmit          # 类型（允许上述 2 个历史错误）
cd web && npx prettier --check <file>
```
