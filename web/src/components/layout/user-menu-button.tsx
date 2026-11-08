import type { ReactNode } from "react";
import { App, Avatar, Dropdown } from "antd";
import { FolderOpen, Globe, LogOut, Moon, Settings2, Sun, User } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { changeAppLocale, type AppLocale } from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

/**
 * 头像 + 用户菜单。站点头部与画布顶栏共用同一份实现，保证两处菜单完全一致。
 * 未登录时不渲染任何内容。
 */
export function UserMenuButton() {
    const { i18n } = useTranslation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const session = useUserStore((state) => state.session);
    const clearSession = useUserStore((state) => state.clearSession);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    if (!session) return null;

    const user = session.user;
    const displayName = user.display_name || user.username || "";
    const avatarLetter = displayName.slice(0, 1).toUpperCase();
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";

    const handleLogout = () => {
        clearSession();
        void message.success("已退出登录");
        navigate("/auth");
    };

    const menuIcon = (icon: ReactNode) => <span className="flex size-4 items-center justify-center text-stone-500 dark:text-stone-400">{icon}</span>;

    const userMenuItems = [
        {
            key: "profile-header",
            label: (
                <div className="px-1 py-2">
                    <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">{displayName}</div>
                    <div className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">余额 {Math.floor((user.quota ?? 0) / 500000)} 元</div>
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
        <Dropdown menu={{ items: userMenuItems }} trigger={["click"]} placement="bottomRight">
            <button type="button" className="ml-1 flex cursor-pointer items-center gap-2 rounded-full outline-none transition hover:opacity-80" aria-label="用户菜单">
                <Avatar size={30} className="shrink-0 bg-stone-700 text-white dark:bg-stone-500" icon={<User className="size-4" />}>
                    {avatarLetter}
                </Avatar>
            </button>
        </Dropdown>
    );
}
