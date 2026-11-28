import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, InputNumber, Select, Spin, Switch, Tag } from "antd";
import { RefreshCw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getAdminNovelConfig, getAdminNovelStatus, updateAdminNovelConfig, type AdminNovelConfig, type AdminNovelStatus, type NovelFormat } from "@/services/api/novel";

type NovelAdminPanelProps = {
    token: string;
    onStatusChanged?: () => void;
};

export function NovelAdminPanel({ token, onStatusChanged }: NovelAdminPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<AdminNovelStatus | null>(null);
    const [config, setConfig] = useState<AdminNovelConfig | null>(null);
    const [errorText, setErrorText] = useState("");

    const loadAll = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setErrorText("");
        try {
            const st = await getAdminNovelStatus(token);
            setStatus(st);
            if (st.available) {
                const cfg = await getAdminNovelConfig(token);
                setConfig(cfg);
            } else {
                setConfig(null);
            }
        } catch (err: unknown) {
            setErrorText(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        } finally {
            setLoading(false);
        }
    }, [t, token]);

    useEffect(() => {
        void loadAll();
    }, [loadAll]);

    const handleSave = async () => {
        if (!token || !config) return;
        setSaving(true);
        try {
            const saved = await updateAdminNovelConfig(token, config);
            setConfig(saved);
            message.success(t("novel.admin.saveSuccess"));
            onStatusChanged?.();
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        } finally {
            setSaving(false);
        }
    };

    const patchConfig = <K extends keyof AdminNovelConfig>(key: K, value: AdminNovelConfig[K]) => {
        setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    };

    return (
        <div className="space-y-5">
            {errorText ? <Alert type="error" message={errorText} showIcon /> : null}

            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-5 shadow-xs dark:border-stone-800 dark:bg-stone-900/70">
                <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{t("novel.admin.statusCardTitle")}</h2>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadAll()}>
                        {t("novel.admin.refreshStatus")}
                    </Button>
                </div>

                {loading && !status ? (
                    <div className="py-6 text-center">
                        <Spin />
                    </div>
                ) : status ? (
                    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                        <StatusItem label={t("novel.admin.version")} value={status.available ? status.version || "-" : status.message || t("novel.statusUnavailable")} />
                        <StatusItem
                            label={t("novel.admin.prewarmState")}
                            value={
                                !status.available ? (
                                    <Tag color="default">{t("novel.statusUnavailable")}</Tag>
                                ) : status.prewarm_error ? (
                                    <Tag color="red">{status.prewarm_error}</Tag>
                                ) : status.prewarm_in_progress ? (
                                    <Tag color="processing">{t("novel.statusWarming")}</Tag>
                                ) : (
                                    <Tag color="green">{t("novel.statusAvailable")}</Tag>
                                )
                            }
                        />
                        <StatusItem label={t("novel.admin.globalActiveJobs")} value={String(status.global_active_jobs ?? 0)} />
                        <StatusItem label={t("novel.admin.saveDir")} value={status.save_dir || "-"} />
                        <StatusItem label={t("novel.admin.bindAddr")} value={status.bind_addr || "-"} />
                        <StatusItem
                            label={t("novel.admin.dockerBuild")}
                            value={`${status.docker_build ? "Docker" : "Binary"} / ${status.locked ? "Locked" : "Open"}`}
                        />
                    </div>
                ) : null}
            </div>

            {config ? (
                <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-5 shadow-xs dark:border-stone-800 dark:bg-stone-900/70">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{t("novel.admin.configCardTitle")}</h2>
                        <Button type="primary" icon={<Save className="size-3.5" />} loading={saving} onClick={() => void handleSave()}>
                            {t("novel.admin.saveConfig")}
                        </Button>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label={t("novel.admin.novelFormat")}>
                            <Select<NovelFormat>
                                className="w-full"
                                value={config.novel_format}
                                onChange={(val) => patchConfig("novel_format", val)}
                                options={[
                                    { value: "txt", label: "TXT" },
                                    { value: "epub", label: "EPUB" },
                                    { value: "pdf", label: "PDF" },
                                    { value: "bulk_txt", label: t("novel.preview.formatBulkTxt") },
                                ]}
                            />
                        </Field>

                        <Field label={t("novel.admin.maxWorkers")}>
                            <InputNumber className="w-full" min={1} max={16} value={config.max_workers} onChange={(v) => patchConfig("max_workers", Number(v) || 1)} />
                        </Field>

                        <Field label={t("novel.admin.requestTimeout")}>
                            <InputNumber
                                className="w-full"
                                min={5}
                                max={120}
                                value={config.request_timeout}
                                onChange={(v) => patchConfig("request_timeout", Number(v) || 15)}
                            />
                        </Field>

                        <Field label={t("novel.admin.maxRetries")}>
                            <InputNumber className="w-full" min={0} max={10} value={config.max_retries} onChange={(v) => patchConfig("max_retries", Number(v) ?? 0)} />
                        </Field>

                        <Field label={t("novel.admin.minWaitTime")}>
                            <InputNumber
                                className="w-full"
                                min={200}
                                max={10000}
                                step={100}
                                value={config.min_wait_time}
                                onChange={(v) => patchConfig("min_wait_time", Number(v) || 200)}
                            />
                        </Field>

                        <Field label={t("novel.admin.maxWaitTime")}>
                            <InputNumber
                                className="w-full"
                                min={200}
                                max={30000}
                                step={100}
                                value={config.max_wait_time}
                                onChange={(v) => patchConfig("max_wait_time", Number(v) || 1000)}
                            />
                        </Field>

                        <Field label={t("novel.admin.firstLineIndentEm")}>
                            <InputNumber
                                className="w-full"
                                min={0}
                                max={8}
                                step={0.5}
                                value={config.first_line_indent_em}
                                onChange={(v) => patchConfig("first_line_indent_em", Number(v) ?? 2)}
                            />
                        </Field>

                        <Field label={t("novel.admin.segmentCommentsTopN")}>
                            <InputNumber
                                className="w-full"
                                min={1}
                                max={50}
                                value={config.segment_comments_top_n}
                                onChange={(v) => patchConfig("segment_comments_top_n", Number(v) || 10)}
                            />
                        </Field>

                        <div className="flex flex-col justify-center gap-3 rounded-xl border border-stone-200/70 px-3 py-2.5 dark:border-stone-800">
                            <SwitchRow
                                label={t("novel.admin.askFormatAfterDownload")}
                                checked={config.ask_format_after_download}
                                onChange={(v) => patchConfig("ask_format_after_download", v)}
                            />
                            <SwitchRow label={t("novel.admin.useOfficialApi")} checked={config.use_official_api} onChange={(v) => patchConfig("use_official_api", v)} />
                            <SwitchRow label={t("novel.admin.autoClearDump")} checked={config.auto_clear_dump} onChange={(v) => patchConfig("auto_clear_dump", v)} />
                            <SwitchRow
                                label={t("novel.admin.enableSegmentComments")}
                                checked={config.enable_segment_comments}
                                onChange={(v) => patchConfig("enable_segment_comments", v)}
                            />
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function StatusItem({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-stone-200/70 bg-stone-50/70 px-3 py-2.5 dark:border-stone-800 dark:bg-stone-950/40">
            <div className="text-xs text-stone-400">{label}</div>
            <div className="mt-1 truncate font-medium text-stone-800 dark:text-stone-100">{value}</div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <div className="text-xs font-medium text-stone-600 dark:text-stone-300">{label}</div>
            {children}
        </div>
    );
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-2 text-xs text-stone-700 dark:text-stone-200">
            <span>{label}</span>
            <Switch size="small" checked={checked} onChange={onChange} />
        </div>
    );
}
