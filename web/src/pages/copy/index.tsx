import { useEffect, useRef, useState } from "react";
import { App, Button, Input } from "antd";
import { Clapperboard, Loader2, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { analyzeVideoGrid, buildFrameGrid, extractSceneFrames, type CopyAnalysis, type CopyItem, type CopyShot } from "@/services/api/copy-video";

const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
/** 分析用的多模态模型：zcapi(OpenAI 渠道) 的 gpt 系列，支持图片输入。 */
const ANALYSIS_MODEL = "gpt-6-sol";

type Section = "roles" | "scenes" | "items";

export default function CopyVideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);

    const [file, setFile] = useState<File | null>(null);
    const [videoUrl, setVideoUrl] = useState("");
    const [analysis, setAnalysis] = useState<CopyAnalysis | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");

    useEffect(
        () => () => {
            if (videoUrl) URL.revokeObjectURL(videoUrl);
        },
        [videoUrl],
    );

    const pickFile = (next: File | null) => {
        if (!next) return;
        if (!next.type.startsWith("video/")) {
            message.warning(t("copyVideo.notVideo"));
            return;
        }
        if (next.size > MAX_VIDEO_BYTES) {
            message.warning(t("copyVideo.tooLarge"));
            return;
        }
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        setFile(next);
        setVideoUrl(URL.createObjectURL(next));
        setAnalysis(null);
        setError("");
    };

    const analyze = async () => {
        if (!file) {
            message.warning(t("copyVideo.needVideo"));
            return;
        }
        if (!isAiConfigReady(config, ANALYSIS_MODEL)) {
            message.warning(t("copyVideo.needGpt"));
            return;
        }
        setAnalyzing(true);
        setError("");
        setAnalysis(null);
        try {
            setProgress(t("copyVideo.extracting"));
            const { frames, meta } = await extractSceneFrames(file, 16);
            setProgress(t("copyVideo.gridding", { frames: frames.length, scenes: meta.sceneCount }));
            const grid = await buildFrameGrid(frames);
            setProgress(t("copyVideo.analyzing"));
            const result = await analyzeVideoGrid(config, grid, meta, ANALYSIS_MODEL);
            setAnalysis(result);
            message.success(t("copyVideo.analyzed"));
        } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") return;
            setError(e instanceof Error ? e.message : t("copyVideo.analyzeFailed"));
        } finally {
            setAnalyzing(false);
            setProgress("");
        }
    };

    const updateItem = (section: Section, id: string, patch: Partial<CopyItem>) => {
        setAnalysis((prev) => {
            if (!prev) return prev;
            return { ...prev, [section]: prev[section].map((item) => (item.id === id ? { ...item, ...patch } : item)) };
        });
    };

    const removeItem = (section: Section, id: string) => {
        setAnalysis((prev) => (prev ? { ...prev, [section]: prev[section].filter((item) => item.id !== id) } : prev));
    };

    const addItem = (section: Section) => {
        setAnalysis((prev) => (prev ? { ...prev, [section]: [...prev[section], { id: `item-${Date.now()}`, name: "", description: "" }] } : prev));
    };

    const updateShot = (id: string, patch: Partial<CopyShot>) => {
        setAnalysis((prev) => (prev ? { ...prev, shots: prev.shots.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)) } : prev));
    };

    const removeShot = (id: string) => {
        setAnalysis((prev) => (prev ? { ...prev, shots: prev.shots.filter((shot) => shot.id !== id) } : prev));
    };

    const sections: { key: Section; label: string }[] = [
        { key: "roles", label: t("copyVideo.roles") },
        { key: "scenes", label: t("copyVideo.scenes") },
        { key: "items", label: t("copyVideo.items") },
    ];

    return (
        <main className="thin-scrollbar h-full overflow-y-auto bg-transparent">
            <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-6 sm:px-8 sm:pt-10">
                <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-stone-950 sm:text-2xl dark:text-stone-50">
                            <Clapperboard className="size-5" />
                            {t("copyVideo.title")}
                        </h1>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">{t("copyVideo.subtitle")}</p>
                    </div>
                    {analysis ? (
                        <Button icon={<Sparkles className="size-4" />} onClick={analyze} loading={analyzing}>
                            {t("copyVideo.reanalyze")}
                        </Button>
                    ) : null}
                </div>

                {!analysis ? (
                    <section className="flex flex-col gap-4 rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                        {videoUrl ? (
                            <div className="relative overflow-hidden rounded-xl bg-black">
                                <video src={videoUrl} controls className="max-h-[420px] w-full object-contain" />
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (videoUrl) URL.revokeObjectURL(videoUrl);
                                        setFile(null);
                                        setVideoUrl("");
                                    }}
                                    className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white transition hover:bg-black/80"
                                    aria-label={t("copyVideo.remove")}
                                >
                                    <X className="size-4" />
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    pickFile(event.dataTransfer.files?.[0] ?? null);
                                }}
                                className="flex min-h-[260px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stone-300 text-center transition hover:border-stone-400 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-900/60"
                            >
                                <Upload className="size-9 text-stone-400" />
                                <div className="text-sm font-medium text-stone-700 dark:text-stone-200">{t("copyVideo.uploadHint")}</div>
                                <div className="text-xs text-stone-400">{t("copyVideo.uploadLimit")}</div>
                            </button>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("copyVideo.analysisHint", { model: ANALYSIS_MODEL })}</div>
                            <Button type="primary" shape="round" icon={<Sparkles className="size-4" />} onClick={analyze} loading={analyzing} disabled={!file}>
                                {t("copyVideo.analyze")}
                            </Button>
                        </div>
                        {progress ? (
                            <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <Loader2 className="size-3.5 animate-spin" />
                                {progress}
                            </div>
                        ) : null}
                        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
                    </section>
                ) : (
                    <div className="flex flex-col gap-6">
                        <div className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                            <div className="text-base font-semibold text-stone-900 dark:text-stone-100">{analysis.title}</div>
                            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                                {t("copyVideo.summary", { roles: analysis.roles.length, scenes: analysis.scenes.length, items: analysis.items.length, shots: analysis.shots.length })}
                            </div>
                        </div>

                        {sections.map((section) => (
                            <section key={section.key} className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                                <div className="mb-3 flex items-center justify-between">
                                    <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">{section.label}</div>
                                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => addItem(section.key)}>
                                        {t("copyVideo.add")}
                                    </Button>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {analysis[section.key].map((item) => (
                                        <div key={item.id} className="flex flex-col gap-2 rounded-xl border border-stone-200/70 p-3 dark:border-stone-800">
                                            <div className="flex items-center gap-2">
                                                <Input size="small" value={item.name} onChange={(event) => updateItem(section.key, item.id, { name: event.target.value })} placeholder={t("copyVideo.namePlaceholder")} />
                                                <Button size="small" type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeItem(section.key, item.id)} />
                                            </div>
                                            <Input.TextArea
                                                value={item.description}
                                                onChange={(event) => updateItem(section.key, item.id, { description: event.target.value })}
                                                rows={3}
                                                placeholder={t("copyVideo.descPlaceholder")}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ))}

                        <section className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                            <div className="mb-3 text-sm font-semibold text-stone-800 dark:text-stone-200">{t("copyVideo.shots")}</div>
                            <div className="flex flex-col gap-3">
                                {analysis.shots.map((shot, index) => (
                                    <div key={shot.id} className="flex flex-col gap-2 rounded-xl border border-stone-200/70 p-3 dark:border-stone-800">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                                {t("copyVideo.shot")} {index + 1}
                                            </span>
                                            <Input size="small" className="!w-24" value={shot.start} onChange={(event) => updateShot(shot.id, { start: event.target.value })} />
                                            <span className="text-xs text-stone-400">→</span>
                                            <Input size="small" className="!w-24" value={shot.end} onChange={(event) => updateShot(shot.id, { end: event.target.value })} />
                                            <Button size="small" type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeShot(shot.id)} />
                                        </div>
                                        <Input.TextArea value={shot.description} onChange={(event) => updateShot(shot.id, { description: event.target.value })} rows={2} placeholder={t("copyVideo.shotDescPlaceholder")} />
                                        <div className="flex flex-wrap gap-1">
                                            {[...shot.roles, ...shot.scenes, ...shot.items].map((tag) => (
                                                <span key={tag} className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <div className="text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.generateHint")}</div>
                    </div>
                )}
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(event) => {
                    pickFile(event.target.files?.[0] ?? null);
                    event.target.value = "";
                }}
            />
        </main>
    );
}
