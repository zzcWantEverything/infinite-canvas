import { useMemo, useRef, useState, type RefObject } from "react";
import { Button, Checkbox, Input, type InputRef } from "antd";
import { ArrowRight, Plus, Replace, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    countAnalysisTermMatches,
    type CopyAnalysis,
    type TermReplaceOptions,
    type TermReplaceRule,
} from "@/services/api/copy-video";

type CopyReplaceBarProps = {
    analysis: CopyAnalysis;
    disabled?: boolean;
    canUndo: boolean;
    inputRef?: RefObject<InputRef | null>;
    onApply: (rules: TermReplaceRule[], options: TermReplaceOptions) => void;
    onUndo: () => void;
};

type RuleRow = { id: number; from: string; to: string };

const MAX_RULE_ROWS = 8;

/** 一键替换品牌/产品条：支持单组或多组词条批量替换全片分镜提示词与素材设定，实时展示命中数并支持撤销。 */
export function CopyReplaceBar({ analysis, disabled, canUndo, inputRef, onApply, onUndo }: CopyReplaceBarProps) {
    const { t } = useTranslation();
    const nextIdRef = useRef(2);
    const [rows, setRows] = useState<RuleRow[]>([{ id: 1, from: "", to: "" }]);
    const [includeAssets, setIncludeAssets] = useState(true);

    const activeRules = useMemo(
        () => rows.filter((row) => row.from.trim().length > 0 && row.from.trim() !== row.to.trim()),
        [rows],
    );
    const hasInput = rows.some((row) => row.from.trim().length > 0);
    const stats = useMemo(
        () =>
            activeRules.length
                ? countAnalysisTermMatches(analysis, activeRules, { includeAssets })
                : { totalMatches: 0, shotCount: 0, assetCount: 0 },
        [analysis, activeRules, includeAssets],
    );

    const updateRow = (id: number, patch: Partial<Pick<RuleRow, "from" | "to">>) => {
        setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    };

    const addRow = () => {
        if (rows.length >= MAX_RULE_ROWS) return;
        setRows((prev) => [...prev, { id: nextIdRef.current++, from: "", to: "" }]);
    };

    const removeRow = (id: number) => {
        setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.id !== id) : prev));
    };

    const handleApply = () => {
        if (disabled || stats.totalMatches === 0 || !activeRules.length) return;
        onApply(
            activeRules.map(({ from, to }) => ({ from, to })),
            { includeAssets },
        );
        setRows([{ id: nextIdRef.current++, from: "", to: "" }]);
    };

    return (
        <section className="rounded-2xl border border-amber-200/80 bg-amber-50/40 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/20">
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex shrink-0 items-center gap-2.5 pt-0.5">
                    <div className="flex size-8 items-center justify-center rounded-xl border border-amber-200/80 bg-amber-100/70 text-amber-700 dark:border-amber-500/30 dark:bg-amber-900/40 dark:text-amber-300">
                        <Replace className="size-4" />
                    </div>
                    <div>
                        <h2 className="text-xs font-semibold text-stone-900 dark:text-stone-100">{t("copyVideo.replaceTitle")}</h2>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400">{t("copyVideo.replaceSubtitle")}</p>
                    </div>
                </div>

                <div className="flex flex-1 flex-col gap-2 lg:max-w-[820px]">
                    <div className="space-y-1.5">
                        {rows.map((row, index) => (
                            <div key={row.id} className="flex items-center gap-1.5">
                                <Input
                                    ref={index === 0 ? inputRef : undefined}
                                    size="small"
                                    disabled={disabled}
                                    value={row.from}
                                    onChange={(event) => updateRow(row.id, { from: event.target.value })}
                                    onPressEnter={handleApply}
                                    placeholder={t("copyVideo.replaceFromPlaceholder")}
                                    allowClear
                                />
                                <ArrowRight className="size-3.5 shrink-0 text-stone-400" />
                                <Input
                                    size="small"
                                    disabled={disabled}
                                    value={row.to}
                                    onChange={(event) => updateRow(row.id, { to: event.target.value })}
                                    onPressEnter={handleApply}
                                    placeholder={t("copyVideo.replaceToPlaceholder")}
                                    allowClear
                                />
                                {rows.length > 1 ? (
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => removeRow(row.id)}
                                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-200/70 hover:text-stone-700 disabled:opacity-50 dark:hover:bg-stone-800 dark:hover:text-stone-200"
                                        title={t("common.delete")}
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                        <Button
                            size="small"
                            icon={<Plus className="size-3" />}
                            disabled={disabled || rows.length >= MAX_RULE_ROWS}
                            onClick={addRow}
                        >
                            {t("copyVideo.replaceAddRow")}
                        </Button>
                        <Checkbox
                            checked={includeAssets}
                            disabled={disabled}
                            onChange={(event) => setIncludeAssets(event.target.checked)}
                            className="!text-xs !text-stone-600 dark:!text-stone-300"
                        >
                            {t("copyVideo.replaceIncludeAssets")}
                        </Checkbox>

                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            {hasInput ? (
                                <span
                                    className={
                                        stats.totalMatches > 0
                                            ? "text-xs font-medium text-amber-700 dark:text-amber-300"
                                            : "text-xs text-stone-400 dark:text-stone-500"
                                    }
                                >
                                    {stats.totalMatches > 0
                                        ? t("copyVideo.replaceMatchSummary", {
                                              total: stats.totalMatches,
                                              shots: stats.shotCount,
                                              assets: stats.assetCount,
                                          })
                                        : t("copyVideo.replaceMatchNone")}
                                </span>
                            ) : null}
                            {canUndo ? (
                                <Button size="small" icon={<RotateCcw className="size-3.5" />} disabled={disabled} onClick={onUndo}>
                                    {t("copyVideo.replaceUndo")}
                                </Button>
                            ) : null}
                            <Button
                                type="primary"
                                size="small"
                                icon={<Replace className="size-3.5" />}
                                disabled={disabled || stats.totalMatches === 0}
                                onClick={handleApply}
                            >
                                {t("copyVideo.replaceAction")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
