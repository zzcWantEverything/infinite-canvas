import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Select, Spin, Tag } from "antd";
import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cleanupNovelPreview, fetchNovelCoverBlobUrl, previewNovel, type NovelFormat, type NovelPreview } from "@/services/api/novel";

export type NovelPreviewConfirmPayload = {
    bookId: string;
    title: string;
    author: string;
    format: NovelFormat;
    rangeStart?: number;
    rangeEnd?: number;
};

type NovelPreviewModalProps = {
    open: boolean;
    bookInput: string;
    token: string;
    submitting: boolean;
    onClose: () => void;
    onConfirm: (payload: NovelPreviewConfirmPayload) => Promise<void>;
};

function formatWordCount(words: number | undefined): string {
    if (!words || words <= 0) return "";
    return words >= 10000 ? `${(words / 10000).toFixed(1)}万字` : `${words}字`;
}

export function NovelPreviewModal({ open, bookInput, token, submitting, onClose, onConfirm }: NovelPreviewModalProps) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [preview, setPreview] = useState<NovelPreview | null>(null);
    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    const [format, setFormat] = useState<NovelFormat>("txt");
    const [rangeInput, setRangeInput] = useState("");
    const [rangeError, setRangeError] = useState("");

    useEffect(() => {
        if (!open || !bookInput || !token) {
            setPreview(null);
            setLoadError("");
            setRangeInput("");
            setRangeError("");
            setCoverUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return null;
            });
            return;
        }

        let active = true;
        const controller = new AbortController();
        let activeObjectUrl: string | null = null;

        setLoading(true);
        setLoadError("");
        setPreview(null);
        setRangeInput("");
        setRangeError("");

        previewNovel(token, bookInput, controller.signal)
            .then(async (data) => {
                if (!active) return;
                setPreview(data);
                setLoading(false);
                const blobUrl = await fetchNovelCoverBlobUrl(token, data, controller.signal);
                if (!active) {
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    return;
                }
                activeObjectUrl = blobUrl;
                setCoverUrl(blobUrl);
            })
            .catch((err: unknown) => {
                if (!active) return;
                setLoading(false);
                setLoadError(err instanceof Error ? err.message : t("apiErrors.requestFailed"));
            });

        return () => {
            active = false;
            controller.abort();
            if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
            cleanupNovelPreview(token, bookInput);
        };
    }, [bookInput, open, t, token]);

    const chapterTotal = preview?.chapter_count || 0;

    const handleConfirm = async () => {
        if (!preview) return;
        const trimmedRange = rangeInput.trim();
        let rangeStart: number | undefined;
        let rangeEnd: number | undefined;

        if (trimmedRange) {
            if (chapterTotal <= 0) {
                setRangeError(t("novel.preview.rangeHintNoCount"));
                return;
            }
            const parts = trimmedRange.split("-").map((p) => p.trim());
            if (parts.length !== 2) {
                setRangeError(t("novel.preview.rangeFormatError"));
                return;
            }
            const start = parts[0] === "" ? 1 : Number.parseInt(parts[0], 10);
            const end = parts[1] === "" ? chapterTotal : Number.parseInt(parts[1], 10);
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > chapterTotal) {
                setRangeError(t("novel.preview.rangeInvalid", { max: chapterTotal }));
                return;
            }
            rangeStart = start;
            rangeEnd = end;
        }

        setRangeError("");
        const resolvedId = preview.resolved_book_id || preview.book_id || bookInput;
        await onConfirm({
            bookId: resolvedId,
            title: preview.book_name || resolvedId,
            author: preview.author || "",
            format,
            rangeStart,
            rangeEnd,
        });
    };

    return (
        <Modal open={open} title={t("novel.preview.title")} onCancel={onClose} footer={null} width={660} destroyOnHidden>
            {loading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-stone-500 dark:text-stone-400">
                    <Spin />
                    <span className="text-sm">{t("novel.preview.loading")}</span>
                </div>
            ) : loadError ? (
                <div className="space-y-4 py-4">
                    <Alert type="error" message={loadError} showIcon />
                    <div className="flex justify-end">
                        <Button onClick={onClose}>{t("novel.preview.cancel")}</Button>
                    </div>
                </div>
            ) : preview ? (
                <div className="space-y-5 pt-2">
                    <div className="flex flex-col gap-4 sm:flex-row">
                        <div className="flex h-40 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900">
                            {coverUrl ? (
                                <img src={coverUrl} alt={preview.book_name || ""} className="h-full w-full object-cover" />
                            ) : (
                                <BookOpen className="size-8 text-stone-400" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-2">
                            <div>
                                <h3 className="text-lg font-semibold text-stone-900 dark:text-stone-100">{preview.book_name || bookInput}</h3>
                                {preview.original_book_name && preview.original_book_name !== preview.book_name ? (
                                    <p className="text-xs text-stone-400">{t("novel.preview.originalTitle", { title: preview.original_book_name })}</p>
                                ) : null}
                            </div>
                            <p className="text-sm text-stone-600 dark:text-stone-300">{preview.author || t("novel.preview.unknownAuthor")}</p>
                            <div className="flex flex-wrap gap-1.5">
                                {preview.finished !== null && preview.finished !== undefined ? (
                                    <Tag color={preview.finished ? "green" : "blue"}>{preview.finished ? t("novel.preview.finished") : t("novel.preview.serializing")}</Tag>
                                ) : null}
                                {chapterTotal > 0 ? <Tag>{t("novel.preview.chapters", { count: chapterTotal })}</Tag> : null}
                                {preview.word_count ? <Tag>{formatWordCount(preview.word_count)}</Tag> : null}
                                {preview.score != null ? <Tag color="gold">{preview.score.toFixed(1)}分</Tag> : null}
                                {preview.category ? <Tag>{preview.category}</Tag> : null}
                                {(preview.tags || []).slice(0, 4).map((tag) => (
                                    <Tag key={tag}>{tag}</Tag>
                                ))}
                            </div>
                            {(preview.first_chapter_title || preview.last_chapter_title) ? (
                                <div className="space-y-0.5 text-xs text-stone-500 dark:text-stone-400">
                                    {preview.first_chapter_title ? <div className="truncate">{t("novel.preview.firstChapter", { title: preview.first_chapter_title })}</div> : null}
                                    {preview.last_chapter_title ? <div className="truncate">{t("novel.preview.lastChapter", { title: preview.last_chapter_title })}</div> : null}
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="max-h-32 overflow-y-auto rounded-xl border border-stone-200/80 bg-stone-50 p-3 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-300">
                        {preview.description || t("novel.preview.noDescription")}
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <div className="text-xs font-medium text-stone-600 dark:text-stone-300">{t("novel.preview.formatLabel")}</div>
                            <Select<NovelFormat>
                                className="w-full"
                                value={format}
                                onChange={setFormat}
                                options={[
                                    { value: "txt", label: t("novel.preview.formatTxt") },
                                    { value: "epub", label: t("novel.preview.formatEpub") },
                                    { value: "pdf", label: t("novel.preview.formatPdf") },
                                    { value: "bulk_txt", label: t("novel.preview.formatBulkTxt") },
                                ]}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <div className="text-xs font-medium text-stone-600 dark:text-stone-300">{t("novel.preview.rangeLabel")}</div>
                            <Input
                                value={rangeInput}
                                disabled={chapterTotal <= 0}
                                placeholder={t("novel.preview.rangePlaceholder")}
                                onChange={(e) => {
                                    setRangeInput(e.target.value);
                                    if (rangeError) setRangeError("");
                                }}
                            />
                            <div className={`text-[11px] ${rangeError ? "text-red-500" : "text-stone-400"}`}>
                                {rangeError || (chapterTotal > 0 ? t("novel.preview.rangeHint", { count: chapterTotal }) : t("novel.preview.rangeHintNoCount"))}
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                        <Button onClick={onClose}>{t("novel.preview.cancel")}</Button>
                        <Button type="primary" loading={submitting} onClick={() => void handleConfirm()}>
                            {t("novel.preview.confirmDownload")}
                        </Button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
