import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

const RULE_KEYS = ["rulePolitical", "ruleSexual", "ruleViolence", "ruleIllegal", "ruleRights", "ruleHate", "ruleMinors", "ruleOther"] as const;

/**
 * 生成前的一条常驻提示。占位符里只能写一句话，用户一动手打字就看不见了，
 * 所以真正承载「会被审核」这件事的是这一行，加一个能展开细则的入口。
 */
export function ContentSafetyHint({ className }: { className?: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);

    return (
        <>
            <div className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400", className)}>
                <ShieldAlert className="size-3.5 shrink-0" />
                <span>{t("contentSafety.hint")}</span>
                <button
                    type="button"
                    className="cursor-pointer border-none bg-transparent p-0 text-xs text-stone-600 underline decoration-stone-300 underline-offset-2 transition-colors hover:text-stone-900 dark:text-stone-300 dark:decoration-stone-600 dark:hover:text-stone-100"
                    onClick={() => setOpen(true)}
                >
                    {t("contentSafety.viewRules")}
                </button>
            </div>
            <ContentSafetyRulesDialog open={open} onOpenChange={setOpen} />
        </>
    );
}

export function ContentSafetyRulesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation();

    return (
        <Modal title={t("contentSafety.rulesTitle")} open={open} onCancel={() => onOpenChange(false)} footer={null} width={640} centered>
            <p className="mb-3 text-sm leading-6 text-stone-600 dark:text-stone-300">{t("contentSafety.rulesIntro")}</p>
            <ul className="m-0 list-none space-y-2 p-0">
                {RULE_KEYS.map((key) => (
                    <li key={key} className="flex gap-2 text-sm leading-6 text-stone-700 dark:text-stone-200">
                        <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-stone-400 dark:bg-stone-500" />
                        <span>{t(`contentSafety.${key}`)}</span>
                    </li>
                ))}
            </ul>
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200">{t("contentSafety.rulesFootnote")}</p>
        </Modal>
    );
}

/**
 * 审核未通过时的可操作建议。和普通失败分开显示，因为「重试」对审核拦截无效，
 * 用户真正要做的是改描述或换素材。
 */
export function ContentSafetyBlockedTips({ className }: { className?: string }) {
    const { t } = useTranslation();

    return <div className={cn("text-xs leading-5", className)}>{t("contentSafety.blockedTips")}</div>;
}
