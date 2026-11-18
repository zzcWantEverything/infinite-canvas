import { Menu, Search } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { SupportContactButton } from "@/components/layout/support-contact-button";
import { UserMenuButton } from "@/components/layout/user-menu-button";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    const submitSearch = () => {
        const text = keyword.trim();
        // 搜完就清空：提示词库页自己有搜索框，两个框同时显示同一个词很别扭。
        setKeyword("");
        navigate(text ? `/prompts?q=${encodeURIComponent(text)}` : "/prompts");
    };

    return (
        <>
            {!hideHeader ? (
                <header className="relative z-20 flex h-16 shrink-0 items-center gap-3 px-4 md:px-6">
                    <div className="flex items-center gap-2 md:hidden">
                        <Link to="/" className="flex shrink-0 items-center" aria-label={t("meta.title")}>
                            <img src="/logo-mark.png" alt={t("meta.title")} className="size-9 object-contain" />
                        </Link>
                        <button
                            type="button"
                            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-stone-600 transition hover:bg-stone-900/[0.06] hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                            onClick={() => setMobileNavOpen(true)}
                            aria-label={t("topNav.openMenu")}
                            title={t("topNav.menu")}
                        >
                            <Menu className="size-5" />
                        </button>
                    </div>

                    <form
                        className="hidden min-w-0 flex-1 justify-center md:flex"
                        onSubmit={(event) => {
                            event.preventDefault();
                            submitSearch();
                        }}
                    >
                        <div className="relative w-full max-w-[520px]">
                            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-stone-400 dark:text-stone-500" />
                            <input
                                value={keyword}
                                onChange={(event) => setKeyword(event.target.value)}
                                placeholder={t("topNav.searchPlaceholder")}
                                aria-label={t("topNav.searchPlaceholder")}
                                className="h-10 w-full rounded-full border border-stone-200/70 bg-stone-100/80 pl-11 pr-16 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-stone-300 focus:bg-background dark:border-stone-800 dark:bg-stone-900/70 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-stone-700"
                            />
                            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-stone-200 bg-background px-1.5 py-0.5 text-[10px] font-medium leading-4 text-stone-400 lg:block dark:border-stone-700 dark:text-stone-500">Enter</kbd>
                        </div>
                    </form>

                    <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                        <UserStatusActions />
                        <SupportContactButton />
                        <UserMenuButton />
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
        </>
    );
}
