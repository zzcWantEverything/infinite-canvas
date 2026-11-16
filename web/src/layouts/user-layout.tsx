import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppSideNav } from "@/components/layout/app-side-nav";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    // 画布项目页要全屏编辑，左侧栏和顶栏都让位。
    const fullscreen = /^\/canvas\/[^/]+/.test(pathname);

    return (
        <div className="flex h-dvh overflow-hidden bg-stone-50 text-foreground dark:bg-stone-950">
            {fullscreen ? null : <AppSideNav />}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}
