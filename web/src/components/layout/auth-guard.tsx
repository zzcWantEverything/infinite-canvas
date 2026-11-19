import { useEffect } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";
import { fetchModelCatalog, invalidateModelCatalogCache } from "@/services/api/model-catalog";

export function AuthGuard({ children }: { children: ReactNode }) {
    const session = useUserStore((state) => state.session);
    const hydrated = useUserStore((state) => state.hydrated);
    const { pathname } = useLocation();
    // 依赖里只放「有没有登录」，不放 token 本身：access token 每 15 分钟续一次，
    // 续期会让 token 变新，若挂在这里就会把目录重新拉一遍，叠加其他组件形成请求风暴。
    const hasSession = Boolean(session?.token);

    // 模型能力目录按登录态取，登录后就预热一次：能力表是同步读取的，界面渲染时最好已经在缓存里。
    // 失败由 model-catalog 自己吞掉，界面回退到内置能力表。
    useEffect(() => {
        const live = useUserStore.getState().session;
        if (!live?.token) {
            invalidateModelCatalogCache();
            return;
        }
        void fetchModelCatalog(live.baseUrl, live.token);
    }, [hasSession, session?.baseUrl]);

    // localforage 异步读取完成前，渲染占位避免白屏
    if (!hydrated) {
        return (
            <div className="flex h-dvh items-center justify-center bg-background">
                <div className="size-5 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
            </div>
        );
    }

    if (!session) {
        return <Navigate to="/auth" state={{ from: pathname }} replace />;
    }

    return <>{children}</>;
}
