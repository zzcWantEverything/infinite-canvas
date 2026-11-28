import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";

import "@/services/api/http";
import { invalidateUserModelsCache } from "@/components/model-picker";
import {
    buildCatalogFingerprint,
    buildPricingFingerprint,
    extractHtmlBuildFingerprint,
    readDocumentBuildFingerprint,
    shouldTriggerUpdate,
} from "@/lib/app-update-detector";
import { invalidateModelCatalogCache } from "@/services/api/model-catalog";
import { invalidatePricingCache, pricingCandidates } from "@/services/api/pricing";
import { withLocalProxy } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const BASELINE_DELAY_MS = 2_000;
const POLL_INTERVAL_MS = 60_000;
const MIN_RECHECK_GAP_MS = 20_000;

function catalogEndpoint(baseUrl: string) {
    const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
    return trimmed ? `${trimmed}/api/user/models/catalog` : "/api/user/models/catalog";
}

export function AppUpdateBanner() {
    const { t } = useTranslation();
    const session = useUserStore((state) => state.session);
    const userScope = `${session?.baseUrl || ""}|${session?.user?.id || "anon"}`;

    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [reloading, setReloading] = useState(false);

    const codeBaselineRef = useRef<string>(readDocumentBuildFingerprint());
    const pricingBaselineRef = useRef<string>("");
    const catalogBaselineRef = useRef<string>("");
    const scopeRef = useRef<string>(userScope);
    const lastCheckAtRef = useRef<number>(0);
    const checkingRef = useRef<boolean>(false);

    const checkForUpdates = useCallback(
        async (force = false) => {
            if (updateAvailable || checkingRef.current) return;
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            const now = Date.now();
            if (!force && now - lastCheckAtRef.current < MIN_RECHECK_GAP_MS) return;

            const checkScope = scopeRef.current;
            const liveSession = useUserStore.getState().session;
            lastCheckAtRef.current = now;
            checkingRef.current = true;

            try {
                const tasks: Array<Promise<boolean>> = [];

                // 1) 前端代码构建更新：比对首页 HTML 中的入口 bundle/css hash（dev 模式无 hash 入口自动跳过）。
                if (codeBaselineRef.current) {
                    tasks.push(
                        (async () => {
                            try {
                                const res = await fetch(`/?_v=${Date.now()}`, {
                                    cache: "no-store",
                                    headers: { Accept: "text/html" },
                                });
                                if (!res.ok) return false;
                                const next = extractHtmlBuildFingerprint(await res.text());
                                return shouldTriggerUpdate(codeBaselineRef.current, next);
                            } catch {
                                return false;
                            }
                        })(),
                    );
                }

                // 2) 后端模型列表/定价/分组倍率更新：同源或后端 /api/pricing（免登录也能检测公开列表，登录后按分组过滤）。
                tasks.push(
                    (async () => {
                        const url = pricingCandidates(liveSession?.baseUrl || "")[0];
                        if (!url) return false;
                        try {
                            const sep = url.includes("?") ? "&" : "?";
                            const res = await fetch(withLocalProxy(`${url}${sep}_v=${Date.now()}`), {
                                cache: "no-store",
                                credentials: "include",
                                headers: { Accept: "application/json" },
                            });
                            if (!res.ok) return false;
                            const json = (await res.json()) as unknown;
                            if (scopeRef.current !== checkScope) return false;
                            const next = buildPricingFingerprint(json);
                            if (!next) return false;
                            if (!pricingBaselineRef.current) {
                                pricingBaselineRef.current = next;
                                return false;
                            }
                            return shouldTriggerUpdate(pricingBaselineRef.current, next);
                        } catch {
                            return false;
                        }
                    })(),
                );

                // 3) 登录用户模型目录（能力/展示名/分组/上下架变化）：静默探测，异常不弹窗。
                if (liveSession?.token) {
                    tasks.push(
                        (async () => {
                            try {
                                const res = await axios.get(catalogEndpoint(liveSession.baseUrl || ""), {
                                    headers: { Authorization: `Bearer ${liveSession.token}` },
                                    params: { _v: Date.now() },
                                    requiresAuth: true,
                                    timeout: 15_000,
                                });
                                if (scopeRef.current !== checkScope) return false;
                                const next = buildCatalogFingerprint(res.data);
                                if (!next) return false;
                                if (!catalogBaselineRef.current) {
                                    catalogBaselineRef.current = next;
                                    return false;
                                }
                                return shouldTriggerUpdate(catalogBaselineRef.current, next);
                            } catch {
                                return false;
                            }
                        })(),
                    );
                }

                const results = await Promise.all(tasks);
                if (results.some(Boolean)) {
                    setUpdateAvailable(true);
                }
            } finally {
                checkingRef.current = false;
            }
        },
        [updateAvailable],
    );

    // 账号或接入地址变化时重置模型基线，防止登录/切换账号误弹更新提示。
    useEffect(() => {
        if (scopeRef.current !== userScope) {
            scopeRef.current = userScope;
            pricingBaselineRef.current = "";
            catalogBaselineRef.current = "";
            lastCheckAtRef.current = 0;
        }
    }, [userScope]);

    useEffect(() => {
        if (updateAvailable) return;
        const onPreloadError = () => setUpdateAvailable(true);
        const onVisibilityOrFocus = () => {
            if (document.visibilityState === "visible") void checkForUpdates(false);
        };

        const initTimer = window.setTimeout(() => void checkForUpdates(true), BASELINE_DELAY_MS);
        const interval = window.setInterval(() => void checkForUpdates(false), POLL_INTERVAL_MS);
        window.addEventListener("vite:preloadError", onPreloadError);
        document.addEventListener("visibilitychange", onVisibilityOrFocus);
        window.addEventListener("focus", onVisibilityOrFocus);

        return () => {
            window.clearTimeout(initTimer);
            window.clearInterval(interval);
            window.removeEventListener("vite:preloadError", onPreloadError);
            document.removeEventListener("visibilitychange", onVisibilityOrFocus);
            window.removeEventListener("focus", onVisibilityOrFocus);
        };
    }, [checkForUpdates, updateAvailable, userScope]);

    const handleReload = () => {
        setReloading(true);
        invalidatePricingCache();
        invalidateModelCatalogCache();
        invalidateUserModelsCache();
        window.location.reload();
    };

    if (!updateAvailable) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="animate-in fade-in slide-in-from-bottom-3 fixed bottom-6 right-6 z-[1100] flex max-w-[calc(100vw-2rem)] items-center justify-between gap-5 rounded-[22px] border border-stone-200/90 bg-white/95 px-5 py-3.5 shadow-[0_12px_36px_rgba(15,23,42,0.12)] backdrop-blur-md duration-200 dark:border-stone-700/80 dark:bg-stone-900/95 dark:shadow-[0_12px_36px_rgba(0,0,0,0.45)]"
        >
            <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-snug text-stone-950 dark:text-stone-50">{t("version.updateToastTitle")}</div>
                <div className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">{t("version.updateToastDesc")}</div>
            </div>
            <button
                type="button"
                disabled={reloading}
                onClick={handleReload}
                className="shrink-0 cursor-pointer rounded-2xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-stone-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
            >
                {reloading ? t("version.updating") : t("version.updateToastAction")}
            </button>
        </div>
    );
}
