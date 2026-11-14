import { useState } from "react";
import { App, Popover } from "antd";
import { Check, Copy, Headphones } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 客服联系方式。站点头部和画布顶栏都放在头像左边，用同一个组件保证两处一致。
 *
 * 点条目直接复制：QQ / 微信号都是一串数字或字母，让用户手抄一遍必然会抄错，
 * 复制后弹 toast 并短暂打勾，给一个明确的成功反馈。
 */
const SUPPORT_CONTACTS = [
    { key: "qq", labelKey: "topNav.supportQq", value: "2446738907" },
    { key: "wechat", labelKey: "topNav.supportWechat", value: "zczzzzczzz" },
] as const;

export function SupportContactButton({ variant = "default" }: { variant?: "default" | "canvas" }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = useThemeStore((state) => state.theme);
    const [open, setOpen] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string>("");

    const triggerClass = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white";
    const triggerStyle = variant === "canvas" ? { color: canvasThemes[theme].node.text } : undefined;

    const handleCopy = async (key: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopiedKey(key);
            void message.success(t("topNav.supportCopied", { value }));
            window.setTimeout(() => setCopiedKey(""), 1600);
        } catch {
            // clipboard 在非 https 或未授权时会 reject，此时让用户自己选中复制。
            void message.error(t("topNav.supportCopyFailed"));
        }
    };

    const content = (
        <div className="w-56">
            <div className="text-sm font-medium text-stone-900 dark:text-stone-100">{t("topNav.contactSupport")}</div>
            <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("topNav.supportHint")}</div>
            <div className="mt-3 space-y-1">
                {SUPPORT_CONTACTS.map((contact) => (
                    <button
                        key={contact.key}
                        type="button"
                        onClick={() => void handleCopy(contact.key, contact.value)}
                        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-stone-100 dark:hover:bg-stone-800"
                    >
                        <span className="min-w-0">
                            <span className="block text-[11px] text-stone-400 dark:text-stone-500">{t(contact.labelKey)}</span>
                            <span className="block truncate text-sm font-medium text-stone-900 tabular-nums dark:text-stone-100">{contact.value}</span>
                        </span>
                        {copiedKey === contact.key ? <Check className="size-4 shrink-0 text-emerald-600" /> : <Copy className="size-4 shrink-0 text-stone-400" />}
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <Popover content={content} trigger="click" placement="bottomRight" arrow={false} open={open} onOpenChange={setOpen}>
            <button type="button" className={triggerClass} style={triggerStyle} aria-label={t("topNav.contactSupport")} title={t("topNav.contactSupport")}>
                <Headphones className="size-4 shrink-0" />
                {variant === "default" ? <span className="hidden text-xs md:inline">{t("topNav.contactSupport")}</span> : null}
            </button>
        </Popover>
    );
}
