import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";

export function AuthGuard({ children }: { children: ReactNode }) {
    const session = useUserStore((state) => state.session);
    const hydrated = useUserStore((state) => state.hydrated);
    const { pathname } = useLocation();

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
