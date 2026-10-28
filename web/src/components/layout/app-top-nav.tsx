import { Sun, Moon, Globe, Menu, Settings2, FolderOpen, LogOut, User } from "lucide-react";
import { App, Avatar, Dropdown } from "antd";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import React, { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { canvasThemes } from "@/lib/canvas-theme";

export function AppTopNav() {
    const { t, i18n } = useTranslation();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const session = useUserStore((state) => state.session);
    const clearSession = useUserStore((state) => state.clearSession);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";

    const displayName = session?.user.display_name || session?.user.username || "";
    const avatarLetter = displayName.slice(0, 1).toUpperCase();

    function handleLogout() {
        clearSession();
        void message.success("已退出登录");
        navigate("/auth");
    }

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    const menuIcon = (icon: React.ReactNode) => (
        <span className="flex size-4 items-center justify-center text-stone-500 dark:text-stone-400">{icon}</span>
    );

    const userMenuItems = [
        {
            key: "profile-header",
            label: (
                <div className="px-1 py-2">
                    <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">{displayName}</div>
                    <div className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">
                        余额 {Math.floor((session?.user.quota ?? 0) / 500000)} 元
                    </div>
                </div>
            ),
            disabled: true,
        },
        { type: "divider" as const },
        {
            key: "profile",
            icon: menuIcon(<User className="size-4" />),
            label: "个人中心",
            onClick: () => navigate("/profile"),
        },
        {
            key: "assets",
            icon: menuIcon(<FolderOpen className="size-4" />),
            label: "我的资产",
            onClick: () => navigate("/assets"),
        },
        {
            key: "config",
            icon: menuIcon(<Settings2 className="size-4" />),
            label: "配置",
            onClick: () => openConfigDialog(false),
        },
        { type: "divider" as const },
        {
            key: "theme",
            icon: menuIcon(theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />),
            label: theme === "dark" ? "切换浅色" : "切换深色",
            onClick: () => setTheme(theme === "dark" ? "light" : "dark"),
        },
        {
            key: "lang",
            icon: menuIcon(<Globe className="size-4" />),
            label: locale === "zh-CN" ? "Switch to English" : "切换中文",
            onClick: () => void changeAppLocale(nextLocale),
        },
        { type: "divider" as const },
        {
            key: "logout",
            icon: menuIcon(<LogOut className="size-4" />),
            label: "退出登录",
            danger: true,
            onClick: handleLogout,
        },
    ];

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-5 px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <img src="/logo.png" alt="画柚" className="size-20 shrink-0 object-contain" />
                            </Link>

                            <button
                                type="button"
                                className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 md:hidden dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label={t("topNav.openMenu")}
                                title={t("topNav.menu")}
                            >
                                <Menu className="size-5" />
                            </button>

                            <nav className="hide-scrollbar ml-8 hidden h-14 min-w-0 items-center gap-7 overflow-x-auto md:flex">
                                {navigationTools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            to={`/${tool.slug}`}
                                            className={cn(
                                                "relative flex h-14 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                                                active
                                                    ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100"
                                                    : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                            )}
                                        >
                                            <Icon className="size-4" />
                                            <span className="truncate">{t(`navigation.${tool.slug}`)}</span>
                                        </Link>
                                    );
                                })}
                            </nav>
                        </div>

                        <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            <UserStatusActions />
                            {session ? (
                                <Dropdown menu={{ items: userMenuItems }} trigger={["click"]} placement="bottomRight">
                                    <button type="button" className="ml-1 flex cursor-pointer items-center gap-2 rounded-full outline-none transition hover:opacity-80" aria-label="用户菜单">
                                        <Avatar size={30} className="shrink-0 bg-stone-700 text-white dark:bg-stone-500" icon={<User className="size-4" />}>
                                            {avatarLetter}
                                        </Avatar>
                                    </button>
                                </Dropdown>
                            ) : null}
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
            <AppConfigModal />
        </>
    );
}
