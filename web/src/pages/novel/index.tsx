import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Badge, Button, Empty, Input, Popconfirm, Progress, Select, Spin, Tabs, Tag } from "antd";
import { BookOpen, Download, Library, RefreshCw, Search, Settings, Trash2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    cancelNovelJob,
    createNovelJob,
    deleteNovelJob,
    downloadNovelFile,
    formatNovelBytes,
    formatNovelTimestamp,
    getNovelStatus,
    listNovelJobs,
    parseNovelBookInput,
    searchNovels,
    submitNovelJobFormat,
    type NovelEngineStatus,
    type NovelFormat,
    type NovelSearchItem,
    type NovelTaskItem,
} from "@/services/api/novel";
import { useUserStore } from "@/stores/use-user-store";
import { NovelAdminPanel } from "./components/novel-admin-panel";
import { NovelPreviewModal, type NovelPreviewConfirmPayload } from "./components/novel-preview-modal";

type TabKey = "search" | "jobs" | "library" | "admin";

function stateTagColor(state: NovelTaskItem["state"]): string {
    switch (state) {
        case "done":
            return "green";
        case "running":
            return "blue";
        case "queued":
            return "default";
        case "partial":
            return "orange";
        case "failed":
            return "red";
        default:
            return "default";
    }
}

export default function NovelPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const session = useUserStore((state) => state.session);
    const token = session?.token || "";

    const [activeTab, setActiveTab] = useState<TabKey>("search");
    const [status, setStatus] = useState<NovelEngineStatus | null>(null);
    const [statusLoading, setStatusLoading] = useState(false);

    const [queryText, setQueryText] = useState("");
    const [searching, setSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [searchResults, setSearchResults] = useState<NovelSearchItem[]>([]);

    const [previewBookInput, setPreviewBookInput] = useState("");
    const [previewOpen, setPreviewOpen] = useState(false);
    const [creatingJob, setCreatingJob] = useState(false);

    const [jobs, setJobs] = useState<NovelTaskItem[]>([]);
    const [jobsLoading, setJobsLoading] = useState(false);
    const [downloadingId, setDownloadingId] = useState<number | null>(null);
    const [downloadPercent, setDownloadPercent] = useState(0);
    const [formatDrafts, setFormatDrafts] = useState<Record<number, NovelFormat>>({});
    const [libraryFilter, setLibraryFilter] = useState("");

    const isAdmin = (session?.user?.role ?? 0) >= 10 || Boolean(status?.is_admin);

    const refreshStatus = useCallback(async () => {
        if (!token) return;
        setStatusLoading(true);
        try {
            const st = await getNovelStatus(token);
            setStatus(st);
        } catch {
            // handled quietly so the user sees offline banner if needed
        } finally {
            setStatusLoading(false);
        }
    }, [token]);

    const refreshJobs = useCallback(
        async (silent = false) => {
            if (!token) return;
            if (!silent) setJobsLoading(true);
            try {
                const items = await listNovelJobs(token);
                setJobs(items);
            } catch (err: unknown) {
                if (!silent) message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
            } finally {
                if (!silent) setJobsLoading(false);
            }
        },
        [message, t, token],
    );

    useEffect(() => {
        if (!token) return;
        void refreshStatus();
        void refreshJobs();
    }, [refreshJobs, refreshStatus, token]);

    const hasActiveOrPendingJobs = useMemo(
        () =>
            jobs.some(
                (item) =>
                    item.state === "queued" ||
                    item.state === "running" ||
                    Boolean(item.format_options?.length) ||
                    Boolean(item.book_name_options?.length) ||
                    ((item.state === "done" || item.state === "partial") && !item.output_rel_path),
            ),
        [jobs],
    );

    useEffect(() => {
        if (!token || !hasActiveOrPendingJobs) return;
        const timer = window.setInterval(() => {
            void refreshJobs(true);
        }, 2500);
        return () => window.clearInterval(timer);
    }, [hasActiveOrPendingJobs, refreshJobs, token]);

    const directBookInput = useMemo(() => parseNovelBookInput(queryText), [queryText]);

    const handleSearchSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        const trimmed = queryText.trim();
        if (!trimmed) {
            message.warning(t("novel.messages.needQuery"));
            return;
        }
        const direct = parseNovelBookInput(trimmed);
        if (direct) {
            setPreviewBookInput(direct);
            setPreviewOpen(true);
            return;
        }
        setSearching(true);
        setActiveTab("search");
        try {
            const items = await searchNovels(token, trimmed);
            setSearchResults(items);
            setHasSearched(true);
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        } finally {
            setSearching(false);
        }
    };

    const handleOpenPreview = (bookId: string) => {
        setPreviewBookInput(bookId);
        setPreviewOpen(true);
    };

    const handleConfirmCreateJob = async (payload: NovelPreviewConfirmPayload) => {
        if (!token) return;
        setCreatingJob(true);
        try {
            const created = await createNovelJob(token, {
                book_id: payload.bookId,
                title: payload.title,
                author: payload.author,
                format: payload.format,
                ...(payload.rangeStart && payload.rangeEnd ? { range_start: payload.rangeStart, range_end: payload.rangeEnd } : {}),
            });
            setJobs((prev) => [created, ...prev.filter((it) => it.id !== created.id)]);
            setPreviewOpen(false);
            setActiveTab("jobs");
            message.success(t("novel.messages.created", { title: created.title || payload.title }));
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        } finally {
            setCreatingJob(false);
        }
    };

    const handleCancel = async (id: number) => {
        if (!token) return;
        try {
            await cancelNovelJob(token, id);
            message.success(t("novel.messages.canceled"));
            await refreshJobs(true);
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        }
    };

    const handleRetry = async (item: NovelTaskItem) => {
        if (!token) return;
        try {
            const created = await createNovelJob(token, {
                book_id: item.book_id,
                title: item.title,
                author: item.author,
                format: item.format || "txt",
                ...(item.range_start > 0 && item.range_end >= item.range_start ? { range_start: item.range_start, range_end: item.range_end } : {}),
            });
            setJobs((prev) => [created, ...prev]);
            message.success(t("novel.messages.created", { title: created.title || item.title }));
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        }
    };

    const handleDelete = async (id: number) => {
        if (!token) return;
        try {
            await deleteNovelJob(token, id);
            setJobs((prev) => prev.filter((item) => item.id !== id));
            message.success(t("novel.messages.deleted"));
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        }
    };

    const handleSubmitManualFormat = async (item: NovelTaskItem) => {
        if (!token) return;
        const chosen = formatDrafts[item.id] || item.format || "txt";
        try {
            const updated = await submitNovelJobFormat(token, item.id, chosen);
            setJobs((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
            message.success(t("novel.messages.formatSubmitted"));
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        }
    };

    const handleDownloadLocal = async (item: NovelTaskItem) => {
        if (!token) return;
        setDownloadingId(item.id);
        setDownloadPercent(0);
        try {
            const fallbackExt = item.output_kind === "dir" ? "zip" : item.format === "bulk_txt" ? "zip" : item.format || "txt";
            const fallbackName = item.output_name || `${item.title || item.book_id}.${fallbackExt}`;
            await downloadNovelFile(token, item.id, fallbackName, setDownloadPercent);
            message.success(t("novel.messages.downloaded", { title: item.title || item.book_id }));
        } catch (err: unknown) {
            message.error(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
        } finally {
            setDownloadingId(null);
            setDownloadPercent(0);
        }
    };

    const activeCount = useMemo(() => jobs.filter((item) => item.state === "queued" || item.state === "running").length, [jobs]);

    const libraryItems = useMemo(() => {
        const kw = libraryFilter.trim().toLowerCase();
        return jobs.filter((item) => {
            if (!item.can_download) return false;
            if (!kw) return true;
            return (
                item.title.toLowerCase().includes(kw) ||
                item.author.toLowerCase().includes(kw) ||
                item.output_name.toLowerCase().includes(kw) ||
                item.book_id.toLowerCase().includes(kw)
            );
        });
    }, [jobs, libraryFilter]);

    const statusBadge = statusLoading ? (
        <Tag color="processing">{t("novel.statusRefreshing")}</Tag>
    ) : !status?.available ? (
        <Tag color="red">{t("novel.statusUnavailable")}</Tag>
    ) : status.prewarm_in_progress ? (
        <Tag color="processing">{t("novel.statusWarming")}</Tag>
    ) : (
        <Tag color="green">
            {t("novel.statusAvailable")}
            {status.version ? ` · ${status.version}` : ""}
        </Tag>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-transparent text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:py-8">
                <div className="mx-auto max-w-6xl space-y-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2.5">
                                <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("novel.title")}</h1>
                                {statusBadge}
                            </div>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("novel.subtitle")}</p>
                        </div>
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void Promise.all([refreshStatus(), refreshJobs()])}>
                            {t("novel.actions.refresh")}
                        </Button>
                    </div>

                    {status && !status.available ? (
                        <Alert type="warning" showIcon message={status.message || t("novel.statusUnavailable")} />
                    ) : status?.prewarm_error ? (
                        <Alert type="warning" showIcon message={status.prewarm_error} />
                    ) : null}

                    <form
                        onSubmit={handleSearchSubmit}
                        className="flex flex-col gap-2.5 rounded-2xl border border-stone-200/80 bg-white/80 p-3 shadow-xs sm:flex-row dark:border-stone-800 dark:bg-stone-900/70"
                    >
                        <Input
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            placeholder={t("novel.searchPlaceholder")}
                            value={queryText}
                            onChange={(e) => setQueryText(e.target.value)}
                            className="flex-1"
                        />
                        <Button type="primary" size="large" htmlType="submit" loading={searching} disabled={status?.available === false}>
                            {directBookInput ? t("novel.directAction") : t("novel.searchAction")}
                        </Button>
                    </form>

                    <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-xs sm:p-5 dark:border-stone-800 dark:bg-stone-900/70">
                        <Tabs
                            activeKey={activeTab}
                            onChange={(key) => setActiveTab(key as TabKey)}
                            items={[
                                {
                                    key: "search",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Search className="size-3.5" />
                                            <span>{t("novel.tabs.search")}</span>
                                        </span>
                                    ),
                                    children: searching ? (
                                        <div className="flex justify-center py-14">
                                            <Spin />
                                        </div>
                                    ) : searchResults.length === 0 ? (
                                        <Empty className="py-10" description={hasSearched ? t("novel.empty.searchNoHit") : t("novel.empty.search")} />
                                    ) : (
                                        <div className="grid gap-3 md:grid-cols-2">
                                            {searchResults.map((book) => (
                                                <div
                                                    key={book.book_id}
                                                    className="flex items-center justify-between gap-3 rounded-xl border border-stone-200/80 bg-stone-50/70 p-3.5 transition hover:border-stone-300 dark:border-stone-800 dark:bg-stone-950/40 dark:hover:border-stone-700"
                                                >
                                                    <div className="min-w-0 flex-1 space-y-1">
                                                        <div className="truncate font-medium text-stone-900 dark:text-stone-100">{book.title}</div>
                                                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                            <span>{book.author || t("novel.preview.unknownAuthor")}</span>
                                                            <span>·</span>
                                                            <code className="rounded bg-stone-200/60 px-1.5 py-0.5 text-[11px] dark:bg-stone-800">{book.book_id}</code>
                                                        </div>
                                                    </div>
                                                    <Button type="primary" size="small" icon={<BookOpen className="size-3.5" />} onClick={() => handleOpenPreview(book.book_id)}>
                                                        {t("novel.actions.previewAndDownload")}
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    ),
                                },
                                {
                                    key: "jobs",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Download className="size-3.5" />
                                            <span>{t("novel.tabs.jobs")}</span>
                                            {activeCount > 0 ? <Badge count={activeCount} size="small" /> : null}
                                        </span>
                                    ),
                                    children: jobsLoading && jobs.length === 0 ? (
                                        <div className="flex justify-center py-14">
                                            <Spin />
                                        </div>
                                    ) : jobs.length === 0 ? (
                                        <Empty className="py-10" description={t("novel.empty.jobs")} />
                                    ) : (
                                        <div className="space-y-3">
                                            {jobs.map((item) => {
                                                const pct =
                                                    item.chapter_total > 0
                                                        ? Math.min(100, Math.round((item.saved_chapters / item.chapter_total) * 100))
                                                        : item.state === "done"
                                                          ? 100
                                                          : 0;
                                                const isActive = item.state === "queued" || item.state === "running";
                                                const needsManualFormat = Boolean(item.format_options?.length);
                                                return (
                                                    <div
                                                        key={item.id}
                                                        className="space-y-2.5 rounded-xl border border-stone-200/80 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-950/40"
                                                    >
                                                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                                            <div className="min-w-0 space-y-1">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <span className="font-medium text-stone-900 dark:text-stone-100">{item.title || item.book_id}</span>
                                                                    <Tag color={stateTagColor(item.state)}>{t(`novel.state.${item.state}`)}</Tag>
                                                                    <Tag>{(item.format || "txt").toUpperCase()}</Tag>
                                                                    {item.range_start > 0 && item.range_end >= item.range_start ? (
                                                                        <Tag>
                                                                            {item.range_start}-{item.range_end}章
                                                                        </Tag>
                                                                    ) : null}
                                                                </div>
                                                                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                                    {item.author ? <span>{item.author}</span> : null}
                                                                    <span>ID: {item.book_id}</span>
                                                                    <span>{formatNovelTimestamp(item.updated_at || item.created_at)}</span>
                                                                    {item.output_size > 0 ? <span>{formatNovelBytes(item.output_size)}</span> : null}
                                                                </div>
                                                            </div>

                                                            <div className="flex flex-wrap items-center gap-2">
                                                                {item.can_download ? (
                                                                    <Button
                                                                        type="primary"
                                                                        size="small"
                                                                        icon={<Download className="size-3.5" />}
                                                                        loading={downloadingId === item.id}
                                                                        onClick={() => void handleDownloadLocal(item)}
                                                                    >
                                                                        {downloadingId === item.id && downloadPercent > 0
                                                                            ? `${downloadPercent}%`
                                                                            : t("novel.actions.downloadLocal")}
                                                                    </Button>
                                                                ) : null}

                                                                {isActive ? (
                                                                    <Button size="small" icon={<XCircle className="size-3.5" />} onClick={() => void handleCancel(item.id)}>
                                                                        {t("novel.actions.cancelTask")}
                                                                    </Button>
                                                                ) : (
                                                                    <>
                                                                        {(item.state === "failed" || item.state === "partial" || item.state === "canceled") ? (
                                                                            <Button size="small" onClick={() => void handleRetry(item)}>
                                                                                {t("novel.actions.retryTask")}
                                                                            </Button>
                                                                        ) : null}
                                                                        <Popconfirm title={t("novel.actions.confirmDelete")} onConfirm={() => void handleDelete(item.id)}>
                                                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                                                                                {t("novel.actions.deleteTask")}
                                                                            </Button>
                                                                        </Popconfirm>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {(isActive || item.chapter_total > 0) ? (
                                                            <div className="flex items-center gap-3">
                                                                <Progress
                                                                    percent={pct}
                                                                    size="small"
                                                                    status={item.state === "failed" ? "exception" : item.state === "done" ? "success" : "active"}
                                                                    className="mb-0 flex-1"
                                                                />
                                                                <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                                                                    {item.chapter_total > 0 ? `${item.saved_chapters}/${item.chapter_total}` : `${pct}%`}
                                                                </span>
                                                            </div>
                                                        ) : null}

                                                        {needsManualFormat ? (
                                                            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 dark:border-amber-700/50 dark:bg-amber-950/30">
                                                                <Select<NovelFormat>
                                                                    size="small"
                                                                    value={formatDrafts[item.id] || item.format || "txt"}
                                                                    onChange={(v) => setFormatDrafts((prev) => ({ ...prev, [item.id]: v }))}
                                                                    options={item.format_options!.map((opt) => ({
                                                                        value: opt.value as NovelFormat,
                                                                        label: opt.label || opt.value,
                                                                    }))}
                                                                    className="min-w-36"
                                                                />
                                                                <Button size="small" type="primary" onClick={() => void handleSubmitManualFormat(item)}>
                                                                    {t("novel.actions.selectFormat")}
                                                                </Button>
                                                            </div>
                                                        ) : null}

                                                        {item.message && (item.state === "failed" || item.state === "partial") ? (
                                                            <Alert type="warning" message={item.message} showIcon />
                                                        ) : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ),
                                },
                                {
                                    key: "library",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Library className="size-3.5" />
                                            <span>{t("novel.tabs.library")}</span>
                                            {libraryItems.length > 0 ? <Badge count={libraryItems.length} size="small" color="#57534e" /> : null}
                                        </span>
                                    ),
                                    children: (
                                        <div className="space-y-4">
                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                                <Input
                                                    allowClear
                                                    placeholder={t("novel.libraryFilterPlaceholder")}
                                                    value={libraryFilter}
                                                    onChange={(e) => setLibraryFilter(e.target.value)}
                                                    className="sm:max-w-xs"
                                                />
                                                <span className="text-xs text-stone-400">{t("novel.retentionNote")}</span>
                                            </div>
                                            {libraryItems.length === 0 ? (
                                                <Empty className="py-10" description={t("novel.empty.library")} />
                                            ) : (
                                                <div className="grid gap-3 md:grid-cols-2">
                                                    {libraryItems.map((item) => (
                                                        <div
                                                            key={item.id}
                                                            className="flex flex-col justify-between gap-3 rounded-xl border border-stone-200/80 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-950/40"
                                                        >
                                                            <div className="space-y-1">
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <span className="truncate font-medium text-stone-900 dark:text-stone-100">
                                                                        {item.output_name || item.title}
                                                                    </span>
                                                                    <Tag>{(item.format || "txt").toUpperCase()}</Tag>
                                                                </div>
                                                                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                                    {item.author ? <span>{item.author}</span> : null}
                                                                    <span>{formatNovelBytes(item.output_size)}</span>
                                                                    <span>{formatNovelTimestamp(item.updated_at || item.created_at)}</span>
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <Button
                                                                    type="primary"
                                                                    size="small"
                                                                    icon={<Download className="size-3.5" />}
                                                                    loading={downloadingId === item.id}
                                                                    onClick={() => void handleDownloadLocal(item)}
                                                                >
                                                                    {t("novel.actions.downloadLocal")}
                                                                </Button>
                                                                <Button size="small" onClick={() => handleOpenPreview(item.book_id)}>
                                                                    {t("novel.actions.redownload")}
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ),
                                },
                                ...(isAdmin
                                    ? [
                                          {
                                              key: "admin",
                                              label: (
                                                  <span className="inline-flex items-center gap-1.5">
                                                      <Settings className="size-3.5" />
                                                      <span>{t("novel.tabs.admin")}</span>
                                                  </span>
                                              ),
                                              children: <NovelAdminPanel token={token} onStatusChanged={() => void refreshStatus()} />,
                                          },
                                      ]
                                    : []),
                            ]}
                        />
                    </div>
                </div>
            </main>

            <NovelPreviewModal
                open={previewOpen}
                bookInput={previewBookInput}
                token={token}
                submitting={creatingJob}
                onClose={() => setPreviewOpen(false)}
                onConfirm={handleConfirmCreateJob}
            />
        </div>
    );
}
