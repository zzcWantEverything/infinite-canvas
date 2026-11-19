import { Drawer } from "antd";
import { Compass } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

/** 移动端抽屉要和桌面侧栏条目一致：首页、五个工具、底部配置，否则在子页面上回不去首页也进不了配置。 */
export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const itemClass = (active: boolean) =>
        cn(
            "flex items-center gap-3 rounded-xl px-3 py-3 text-base transition",
            active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
        );

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-1">
                <Link to="/" onClick={onClose} className={itemClass(pathname === "/")}>
                    <Compass className="size-5" />
                    <span>{t("navigation.home")}</span>
                </Link>
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    return (
                        <Link key={tool.slug} to={`/${tool.slug}`} onClick={onClose} className={itemClass(tool.slug === activeToolSlug)}>
                            <Icon className="size-5" />
                            <span>{t(`navigation.${tool.slug}`)}</span>
                        </Link>
                    );
                })}
            </div>

        </Drawer>
    );
}
