import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

// 本地开发直连线上后端：IP 的 80 端口会被 nginx 301 到 https 站点，
// 登录请求一旦被重定向，refresh cookie 就落在错误域名上，之后所有请求都认不出 token。
// 所以默认走 https 域名，而不是裸 IP。
const apiTarget = (process.env.VITE_API_BASE || "https://admin.huayou.cloud").replace(/\/+$/, "");

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    server: {
        proxy: {
            "/api": {
                target: apiTarget,
                changeOrigin: true,
                // new-api 的 /api/user/auth/refresh 会校验 Origin 与请求 Host 是否一致（SessionCookieOriginGuard）。
                // 本地页面跑在 localhost:3000，Origin 必然对不上，这里统一改写成后端自己的来源。
                configure: (proxy) => {
                    proxy.on("proxyReq", (proxyReq) => {
                        proxyReq.setHeader("Origin", apiTarget);
                        proxyReq.setHeader("Referer", `${apiTarget}/`);
                    });
                },
            },
            "/v1": {
                target: apiTarget,
                changeOrigin: true,
            },
        },
    },
});
