import { Compass } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

/**
 * 即梦式左侧竖向导航：图标 + 小字，激活项用浅色药丸背景。
 * 画布项目页需要全屏编辑，由 UserLayout 决定不渲染本组件。
 */
export function AppSideNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    return (
        <aside className="hidden h-full w-[88px] shrink-0 flex-col items-center border-r border-stone-200/60 bg-background py-4 md:flex dark:border-stone-800/60">
            <Link
                to="/"
                className="mb-3 flex size-12 shrink-0 items-center justify-center rounded-2xl transition hover:bg-stone-100 dark:hover:bg-stone-800"
                aria-label={t("meta.title")}
                title={t("meta.title")}
            >
                <img src="/logo-mark.png" alt={t("meta.title")} className="size-10 object-contain" />
            </Link>

            <nav className="hide-scrollbar flex w-full min-h-0 flex-col items-center gap-1 overflow-y-auto">
                <SideNavItem to="/" icon={Compass} label={t("navigation.home")} active={pathname === "/"} />
                {navigationTools.map((tool) => (
                    <SideNavItem key={tool.slug} to={`/${tool.slug}`} icon={tool.icon} label={t(`navigation.${tool.slug}`)} active={tool.slug === activeToolSlug} />
                ))}
            </nav>

        </aside>
    );
}

function SideNavItem({ to, icon: Icon, label, active }: { to: string; icon: typeof Compass; label: string; active: boolean }) {
    return (
        <Link
            to={to}
            title={label}
            className={cn(
                "flex w-[68px] shrink-0 flex-col items-center gap-1 rounded-2xl px-1 py-2.5 text-[11px] leading-4 transition-colors",
                active
                    ? "bg-stone-900/[0.06] font-medium text-stone-950 dark:bg-white/10 dark:text-white"
                    : "text-stone-500 hover:bg-stone-900/[0.04] hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/5 dark:hover:text-stone-100",
            )}
        >
            <Icon className="size-5 shrink-0" strokeWidth={active ? 2 : 1.7} />
            <span className="w-full truncate text-center">{label}</span>
        </Link>
    );
}
