import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Input, Popconfirm } from "antd";
import { ChevronDown, ChevronUp, Clapperboard, History, ImagePlus, Loader2, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CopySettingsPanel, createCopyGenSettings, type CopyGenSettings } from "@/components/copy/copy-settings-panel";
import { videoModelCapability } from "@/config/video-models";
import { computeMediaSize, mediaRatioOptions } from "@/lib/media-size";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { analyzeVideoGrid, buildFrameGrid, extractAudioWav, extractSceneFrames, generateItemImage, generateShotVideo, groupFramesIntoBatches, mergeBatchAnalyses, transcribeAudio, type CopyAnalysis, type CopyItem, type CopyShot } from "@/services/api/copy-video";
import { createCopyHistory, deleteCopyHistory, formatHistoryTime, getCopyHistory, listCopyHistory, updateCopyHistory, type CopyHistorySummary } from "@/services/api/copy-history";
import { awaitCloudUploads, serializeDoc } from "@/services/canvas-cloud";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
/** 分析用的多模态模型：zcapi(OpenAI 渠道) 的 gpt 系列，支持图片输入。 */
const ANALYSIS_MODEL = "gpt-6-sol";

type Section = "roles" | "scenes" | "items";
/** 已入库的素材：url 只用于当前会话预览，storageKey 才是能跨设备找回的那份。 */
type CopyMedia = { url: string; storageKey: string };

export default function CopyVideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<string | null>(null);
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);

    const [file, setFile] = useState<File | null>(null);
    const [videoUrl, setVideoUrl] = useState("");
    const [analysis, setAnalysis] = useState<CopyAnalysis | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    // 角色/场景/物品 → 生成图；分镜 → 生成视频
    const [itemImages, setItemImages] = useState<Record<string, CopyMedia>>({});
    const [itemStatus, setItemStatus] = useState<Record<string, string>>({});
    const [shotVideos, setShotVideos] = useState<Record<string, CopyMedia>>({});
    const [shotStatus, setShotStatus] = useState<Record<string, string>>({});
    const [batchRunning, setBatchRunning] = useState<"" | "image" | "video">("");
    // 当前编辑中的历史记录：分析完自动建一条，之后编辑/生成都更新它。
    const [historyId, setHistoryId] = useState<number | null>(null);
    const historyIdRef = useRef<number | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyList, setHistoryList] = useState<CopyHistorySummary[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [sourceMeta, setSourceMeta] = useState<{ sceneCount?: number; frameCount?: number; duration?: number } | null>(null);
    // 云端保存要等素材上传落地，串行化避免同一份记录并发写。
    const savingRef = useRef(false);
    const sessionToken = useUserStore((state) => state.session?.token || "");

    const syncHistoryId = (id: number | null) => {
        historyIdRef.current = id;
        setHistoryId(id);
    };
    // 统一参数：一套生图参数喂所有角色/场景/物品，一套生视频参数喂所有分镜。
    const [genSettings, setGenSettings] = useState<CopyGenSettings>(() => createCopyGenSettings(config));

    const patchSettings = (patch: Partial<CopyGenSettings>) => setGenSettings((prev) => ({ ...prev, ...patch }));

    // 生成阶段用的配置：把面板里选的模型/比例/分辨率/时长盖到全局配置上，
    // 这样 requestGeneration / createVideoGenerationTask 走的就是面板选择，而不是全局默认。
    const imageConfig = useMemo(
        () => ({
            ...config,
            model: genSettings.imageModel,
            imageModel: genSettings.imageModel,
            size: computeMediaSize(genSettings.imageScale, genSettings.imageRatio),
            count: "1",
        }),
        [config, genSettings.imageModel, genSettings.imageScale, genSettings.imageRatio],
    );

    const videoConfig = useMemo(
        () => ({
            ...config,
            model: genSettings.videoModel,
            videoModel: genSettings.videoModel,
            size: genSettings.videoRatio,
            vquality: genSettings.videoResolution,
            videoSeconds: genSettings.videoSeconds,
        }),
        [config, genSettings.videoModel, genSettings.videoRatio, genSettings.videoResolution, genSettings.videoSeconds],
    );

    /**
     * 分镜自己的时长 → 模型支持的档位。面板选「按分镜时长」时用这个，
     * 复刻出来的节奏才和原片一致（统一 5 秒会把快切镜头全拖成慢镜头）。
     */
    const shotSeconds = (shot: CopyShot) => {
        const numeric = Number(String(shot.duration || "").replace(/[^0-9.]/g, ""));
        let seconds = Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
        if (!Number.isFinite(seconds)) {
            const timecode = (value: string) => {
                const parts = String(value || "")
                    .trim()
                    .split(":")
                    .map((part) => Number(part));
                if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return NaN;
                return parts.reduce((acc, part) => acc * 60 + part, 0);
            };
            const start = timecode(shot.start);
            const end = timecode(shot.end);
            seconds = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : NaN;
        }
        if (!Number.isFinite(seconds)) return genSettings.videoSeconds === "auto" ? "5" : genSettings.videoSeconds;
        const capability = videoModelCapability(genSettings.videoModel);
        const { min, max, step } = capability?.seconds ?? { min: 4, max: 30, step: 1 };
        const stride = step && step > 0 ? step : 1;
        const snapped = Math.round(seconds / stride) * stride;
        return String(Math.min(max, Math.max(min, snapped)));
    };

    const videoConfigFor = (shot: CopyShot) => (genSettings.videoSeconds === "auto" ? { ...videoConfig, videoSeconds: shotSeconds(shot) } : videoConfig);

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
        // /api/user/copy/* 认的是后台登录态 token，不是渠道里的中转 key；
        // 没登录的话这里直接拦住，别等抽完帧才报「access token 无效」。
        const sessionToken = useUserStore.getState().session?.token || "";
        if (!sessionToken) {
            message.warning(t("copyVideo.needLogin"));
            return;
        }
        setAnalyzing(true);
        setError("");
        setAnalysis(null);
        try {
            setProgress(t("copyVideo.extracting"));
            const { frames, meta } = await extractSceneFrames(file, 32);
            setProgress(t("copyVideo.gridding", { frames: frames.length, scenes: meta.sceneCount }));
            // 音轨转写（失败降级为无台词，不阻塞分析）
            setProgress(t("copyVideo.transcribing"));
            let transcript = "";
            try {
                const audio = await extractAudioWav(file);
                if (audio) transcript = await transcribeAudio(config.baseUrl, sessionToken, audio.blob);
            } catch {
                transcript = "";
            }
            // 按场景分批：每批 6 个镜头 / 9 帧，宫格能画得更大，模型也不用同时盯整条时间线。
            // 串行是有意的——后一批要吃前一批定下的角色/场景名字，并行就会各叫各的。
            const batches = groupFramesIntoBatches(frames);
            let result: CopyAnalysis | null = null;
            for (let index = 0; index < batches.length; index += 1) {
                setProgress(
                    batches.length > 1
                        ? t("copyVideo.analyzingBatch", { current: index + 1, total: batches.length })
                        : t("copyVideo.analyzing"),
                );
                const batchFrames = batches[index];
                const grid = await buildFrameGrid(batchFrames, meta.width / meta.height);
                let partial: CopyAnalysis;
                try {
                    partial = await analyzeVideoGrid(config, grid, meta, ANALYSIS_MODEL, sessionToken, transcript, undefined, {
                        index: index + 1,
                        total: batches.length,
                        startTime: batchFrames[0].time,
                        endTime: batchFrames[batchFrames.length - 1].time,
                        known: result ? { roles: result.roles, scenes: result.scenes, items: result.items } : undefined,
                    });
                } catch (batchError) {
                    // 已经拿到部分结果就别整单作废：后面几批失败时提示一句，保住前面分析好的镜头。
                    if (!result) throw batchError;
                    message.warning(t("copyVideo.batchPartial", { current: index + 1, total: batches.length }));
                    break;
                }
                result = result ? mergeBatchAnalyses([result, partial]) : partial;
            }
            if (!result) throw new Error(t("copyVideo.analyzeFailed"));
            setAnalysis(result);
            setSourceMeta({ sceneCount: meta.sceneCount, frameCount: frames.length });
            // 新的一次分析 → 新的一条历史，之前的记录保持原样。
            syncHistoryId(null);
            // 分析出的片子比例直接作为生图/生视频的默认比例，避免竖屏素材被生成成横屏。
            const ratio = (result.ratio || "").trim();
            if (mediaRatioOptions.some((item) => item.value === ratio)) patchSettings({ imageRatio: ratio, videoRatio: ratio });
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
        setAnalysis((prev) => (prev ? { ...prev, [section]: [...prev[section], { id: `${section}-${Date.now()}`, name: "", description: "" }] } : prev));
    };

    const updateShot = (id: string, patch: Partial<CopyShot>) => {
        setAnalysis((prev) => (prev ? { ...prev, shots: prev.shots.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)) } : prev));
    };

    const removeShot = (id: string) => {
        setAnalysis((prev) => (prev ? { ...prev, shots: prev.shots.filter((shot) => shot.id !== id) } : prev));
    };

    const addShot = () => {
        setAnalysis((prev) =>
            prev
                ? {
                      ...prev,
                      shots: [
                          ...prev.shots,
                          {
                              id: `shot-${Date.now()}`,
                              start: "",
                              end: "",
                              duration: "",
                              shotSize: "",
                              cameraAngle: "",
                              cameraMove: "",
                              description: "",
                              performance: "",
                              sound: "",
                              dialogue: "",
                              onScreenText: "",
                              roles: [],
                              scenes: [],
                              items: [],
                          },
                      ],
                  }
                : prev,
        );
    };

    // 分镜顺序就是成片顺序，允许上下调整。
    const moveShot = (id: string, delta: -1 | 1) => {
        setAnalysis((prev) => {
            if (!prev) return prev;
            const index = prev.shots.findIndex((shot) => shot.id === id);
            const target = index + delta;
            if (index < 0 || target < 0 || target >= prev.shots.length) return prev;
            const shots = [...prev.shots];
            [shots[index], shots[target]] = [shots[target], shots[index]];
            return { ...prev, shots };
        });
    };

    // 自己上传参考图：覆盖 AI 生成的那张，后续生视频会用它当参考。
    const pickItemImage = (id: string) => {
        uploadTargetRef.current = id;
        uploadInputRef.current?.click();
    };

    const applyUploadedImage = (file: File | null) => {
        const id = uploadTargetRef.current;
        uploadTargetRef.current = null;
        if (!file || !id) return;
        void uploadMediaFile(file, "image").then((media) => {
            setItemImages((prev) => ({ ...prev, [id]: { url: media.url, storageKey: media.storageKey } }));
        });
    };

    const sections: { key: Section; label: string }[] = [
        { key: "roles", label: t("copyVideo.roles") },
        { key: "scenes", label: t("copyVideo.scenes") },
        { key: "items", label: t("copyVideo.items") },
    ];

    /**
     * 分镜涉及的角色/场景图作为参考图传给视频模型，保证人物外观和场景一致性。
     * 分镜里没打标签时（模型漏写），退回用已生成的场景图 + 角色图各取前几张。
     */
    const referencesForShot = (shot: CopyShot): ReferenceImage[] => {
        if (!analysis) return [];
        const collect = (names: string[], items: CopyItem[]) => {
            const refs: ReferenceImage[] = [];
            for (const name of names) {
                const item = items.find((entry) => entry.name === name);
                const media = item ? itemImages[item.id] : undefined;
                if (item && media?.url) refs.push({ id: item.id, name: item.name, type: "image/png", dataUrl: media.url });
            }
            return refs;
        };
        const named = [...collect(shot.roles, analysis.roles), ...collect(shot.scenes, analysis.scenes), ...collect(shot.items, analysis.items)];
        if (named.length) return named.slice(0, 4);
        const generated = (items: CopyItem[]) =>
            items.filter((item) => itemImages[item.id]?.url).map((item) => ({ id: item.id, name: item.name, type: "image/png", dataUrl: itemImages[item.id].url }));
        return [...generated(analysis.scenes), ...generated(analysis.roles)].slice(0, 2);
    };

    const runItemImage = async (item: CopyItem) => {
        setItemStatus((prev) => ({ ...prev, [item.id]: "running" }));
        try {
            const dataUrl = await generateItemImage(imageConfig, item);
            // 生成结果先落到本地素材库（随后台同步上云）：历史记录只存 storageKey，
            // 否则一张几 MB 的 base64 会把记录撑爆。
            const media = await uploadMediaFile(dataUrl, "image");
            setItemImages((prev) => ({ ...prev, [item.id]: { url: media.url, storageKey: media.storageKey } }));
            setItemStatus((prev) => ({ ...prev, [item.id]: "done" }));
        } catch (e) {
            setItemStatus((prev) => ({ ...prev, [item.id]: "failed" }));
            if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "生图失败");
        }
    };

    const runShotVideo = async (shot: CopyShot) => {
        setShotStatus((prev) => ({ ...prev, [shot.id]: "running" }));
        try {
            const media = await generateShotVideo(videoConfigFor(shot), shot, referencesForShot(shot));
            setShotVideos((prev) => ({ ...prev, [shot.id]: { url: media.url, storageKey: media.storageKey } }));
            setShotStatus((prev) => ({ ...prev, [shot.id]: "done" }));
        } catch (e) {
            setShotStatus((prev) => ({ ...prev, [shot.id]: "failed" }));
            if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "生视频失败");
        }
    };

    // 并发 2，避免把上游和本机同时打满
    const runBatch = async (kind: "image" | "video") => {
        if (!analysis || batchRunning) return;
        setBatchRunning(kind);
        const tasks = kind === "image" ? [...analysis.roles, ...analysis.scenes, ...analysis.items] : analysis.shots;
        const queue = [...tasks];
        const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
            for (;;) {
                const next = queue.shift();
                if (!next) return;
                if (kind === "image") await runItemImage(next as CopyItem);
                else await runShotVideo(next as CopyShot);
            }
        });
        await Promise.all(workers);
        setBatchRunning("");
    };

    /** 历史里的素材只存 storageKey，换设备后靠它重新换回可访问的 URL。 */
    const resolveMediaMap = async (map?: Record<string, CopyMedia>) => {
        const resolved: Record<string, CopyMedia> = {};
        for (const [id, media] of Object.entries(map || {})) {
            if (!media?.storageKey) continue;
            const url = await resolveMediaUrl(media.storageKey, "").catch(() => "");
            if (url) resolved[id] = { url, storageKey: media.storageKey };
        }
        return resolved;
    };

    const refreshHistoryList = async () => {
        if (!sessionToken) return;
        setHistoryLoading(true);
        try {
            setHistoryList(await listCopyHistory(sessionToken));
        } catch (e) {
            message.error(e instanceof Error ? e.message : t("copyVideo.historyLoadFailed"));
        } finally {
            setHistoryLoading(false);
        }
    };

    const openHistory = () => {
        setHistoryOpen(true);
        void refreshHistoryList();
    };

    /** 把当前编辑内容存成一条历史（首次创建，之后更新同一条）。 */
    const persistHistory = async () => {
        if (!analysis || !sessionToken || savingRef.current) return;
        savingRef.current = true;
        try {
            // 素材上传是后台进行的，先等它们落地，serializeDoc 才能拿到 objectKey。
            await awaitCloudUploads();
            const doc = await serializeDoc({
                version: 1,
                title: analysis.title || "",
                fileName: file?.name || "",
                source: sourceMeta,
                analysis,
                settings: genSettings,
                itemImages,
                shotVideos,
            });
            const payload = { title: analysis.title || file?.name || "未命名", doc, shot_count: analysis.shots.length };
            const current = historyIdRef.current;
            if (current) {
                await updateCopyHistory(sessionToken, current, payload);
            } else {
                const record = await createCopyHistory(sessionToken, payload);
                syncHistoryId(record.id);
            }
        } catch (e) {
            // 历史保存失败不该打断编辑，只记一条警告；用户下次改动会再试。
            console.warn("copy history save failed", e);
        } finally {
            savingRef.current = false;
        }
    };

    // 分析结果、参数、素材任一变化 → 1.5 秒后同步到云端历史。
    useEffect(() => {
        if (!analysis || !sessionToken) return;
        const timer = window.setTimeout(() => void persistHistory(), 1500);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analysis, genSettings, itemImages, shotVideos, sessionToken]);

    const loadHistory = async (id: number) => {
        if (!sessionToken) return;
        setHistoryLoading(true);
        try {
            const record = await getCopyHistory(sessionToken, id);
            const doc = JSON.parse(record.doc || "{}") as {
                analysis?: CopyAnalysis;
                settings?: CopyGenSettings;
                itemImages?: Record<string, CopyMedia>;
                shotVideos?: Record<string, CopyMedia>;
                source?: { sceneCount?: number; frameCount?: number } | null;
            };
            if (!doc.analysis) throw new Error(t("copyVideo.historyBroken"));
            setAnalysis(doc.analysis);
            setSourceMeta(doc.source ?? null);
            if (doc.settings) setGenSettings({ ...createCopyGenSettings(config), ...doc.settings });
            setItemImages(await resolveMediaMap(doc.itemImages));
            setShotVideos(await resolveMediaMap(doc.shotVideos));
            setItemStatus({});
            setShotStatus({});
            setError("");
            syncHistoryId(record.id);
            setHistoryOpen(false);
        } catch (e) {
            message.error(e instanceof Error ? e.message : t("copyVideo.historyLoadFailed"));
        } finally {
            setHistoryLoading(false);
        }
    };

    const removeHistory = async (id: number) => {
        if (!sessionToken) return;
        try {
            await deleteCopyHistory(sessionToken, id);
            setHistoryList((prev) => prev.filter((item) => item.id !== id));
            if (historyIdRef.current === id) syncHistoryId(null);
        } catch (e) {
            message.error(e instanceof Error ? e.message : t("copyVideo.historyDeleteFailed"));
        }
    };

    return (
        <main className="thin-scrollbar h-full overflow-y-auto bg-transparent">
            <div className="mx-auto w-full max-w-[1720px] px-5 pb-20 pt-6 sm:px-8 sm:pt-10">
                <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-stone-950 sm:text-2xl dark:text-stone-50">
                            <Clapperboard className="size-5" />
                            {t("copyVideo.title")}
                        </h1>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">{t("copyVideo.subtitle")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button icon={<History className="size-4" />} onClick={openHistory}>
                            {t("copyVideo.history")}
                        </Button>
                        {analysis ? (
                            <Button icon={<Sparkles className="size-4" />} onClick={analyze} loading={analyzing}>
                                {t("copyVideo.reanalyze")}
                            </Button>
                        ) : null}
                    </div>
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
                                {analysis.ratio ? <span className="mr-2 rounded bg-stone-100 px-1.5 py-0.5 dark:bg-stone-800">{analysis.ratio}</span> : null}
                                {t("copyVideo.summary", { roles: analysis.roles.length, scenes: analysis.scenes.length, items: analysis.items.length, shots: analysis.shots.length })}
                            </div>
                        </div>

                        <CopySettingsPanel config={config} value={genSettings} onChange={patchSettings} disabled={Boolean(batchRunning)} />

                        {sections.map((section) => (
                            <section key={section.key} className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                                <div className="mb-3 flex items-center justify-between gap-2">
                                    <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">{section.label}</div>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<Sparkles className="size-3.5" />} loading={batchRunning === "image"} disabled={Boolean(batchRunning)} onClick={() => void runBatch("image")}>
                                            {t("copyVideo.batchImage")}
                                        </Button>
                                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => addItem(section.key)}>
                                            {t("copyVideo.add")}
                                        </Button>
                                    </div>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
                                            {itemImages[item.id] ? (
                                                <img src={itemImages[item.id].url} alt={item.name} className="max-h-40 w-full rounded-lg object-cover" />
                                            ) : null}
                                            <div className="flex gap-2">
                                                <Button size="small" className="flex-1" icon={<Sparkles className="size-3.5" />} loading={itemStatus[item.id] === "running"} disabled={Boolean(batchRunning)} onClick={() => void runItemImage(item)}>
                                                    {itemImages[item.id] ? t("copyVideo.regenerate") : t("copyVideo.genImage")}
                                                </Button>
                                                <Button size="small" icon={<ImagePlus className="size-3.5" />} title={t("copyVideo.uploadImage")} disabled={Boolean(batchRunning)} onClick={() => pickItemImage(item.id)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ))}

                        <section className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                                <div className="mb-3 flex items-center justify-between gap-2">
                                    <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">{t("copyVideo.shots")}</div>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<Sparkles className="size-3.5" />} loading={batchRunning === "video"} disabled={Boolean(batchRunning)} onClick={() => void runBatch("video")}>
                                            {t("copyVideo.batchVideo")}
                                        </Button>
                                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={addShot} disabled={Boolean(batchRunning)}>
                                            {t("copyVideo.add")}
                                        </Button>
                                    </div>
                                </div>
                            <div className="grid gap-3 xl:grid-cols-2">
                                {analysis.shots.map((shot, index) => (
                                    <div key={shot.id} className="flex flex-col gap-2 rounded-xl border border-stone-200/70 p-3 dark:border-stone-800">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                                {t("copyVideo.shot")} {index + 1}
                                            </span>
                                            <Input size="small" className="!w-24" value={shot.start} onChange={(event) => updateShot(shot.id, { start: event.target.value })} />
                                            <span className="text-xs text-stone-400">→</span>
                                            <Input size="small" className="!w-24" value={shot.end} onChange={(event) => updateShot(shot.id, { end: event.target.value })} />
                                            <Button size="small" type="text" icon={<ChevronUp className="size-3.5" />} disabled={index === 0} onClick={() => moveShot(shot.id, -1)} />
                                            <Button size="small" type="text" icon={<ChevronDown className="size-3.5" />} disabled={index === analysis.shots.length - 1} onClick={() => moveShot(shot.id, 1)} />
                                            <Button size="small" type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeShot(shot.id)} />
                                        </div>
                                        <div className="flex flex-wrap gap-1 text-[11px] text-stone-500 dark:text-stone-400">
                                            {shot.shotSize ? <span className="rounded bg-stone-100 px-1.5 py-0.5 dark:bg-stone-800">{shot.shotSize}</span> : null}
                                            {shot.cameraAngle ? <span className="rounded bg-stone-100 px-1.5 py-0.5 dark:bg-stone-800">{shot.cameraAngle}</span> : null}
                                            {shot.cameraMove ? <span className="rounded bg-stone-100 px-1.5 py-0.5 dark:bg-stone-800">{shot.cameraMove}</span> : null}
                                            {shot.duration ? <span className="rounded bg-stone-100 px-1.5 py-0.5 dark:bg-stone-800">{shot.duration}</span> : null}
                                        </div>
                                        <Input.TextArea value={shot.description} onChange={(event) => updateShot(shot.id, { description: event.target.value })} rows={3} placeholder={t("copyVideo.shotDescPlaceholder")} />
                                        <Input.TextArea value={shot.performance} onChange={(event) => updateShot(shot.id, { performance: event.target.value })} rows={2} placeholder={t("copyVideo.performancePlaceholder")} className="!text-xs" />
                                        <Input.TextArea value={shot.sound} onChange={(event) => updateShot(shot.id, { sound: event.target.value })} rows={2} placeholder={t("copyVideo.soundPlaceholder")} className="!text-xs" />
                                        <Input.TextArea
                                            value={shot.dialogue}
                                            onChange={(event) => updateShot(shot.id, { dialogue: event.target.value })}
                                            rows={1}
                                            placeholder={t("copyVideo.dialoguePlaceholder")}
                                            className="!text-xs"
                                        />
                                        <Input.TextArea value={shot.onScreenText} onChange={(event) => updateShot(shot.id, { onScreenText: event.target.value })} rows={1} placeholder={t("copyVideo.onScreenTextPlaceholder")} className="!text-xs" />
                                        {shotVideos[shot.id] ? <video src={shotVideos[shot.id].url} controls className="max-h-52 w-full rounded-lg bg-black object-contain" /> : null}
                                        <Button size="small" icon={<Sparkles className="size-3.5" />} loading={shotStatus[shot.id] === "running"} disabled={Boolean(batchRunning)} onClick={() => void runShotVideo(shot)}>
                                            {shotVideos[shot.id] ? t("copyVideo.regenerate") : t("copyVideo.genVideo")}
                                        </Button>
                                        <div className="flex flex-wrap gap-1">
                                            {[...shot.roles, ...shot.scenes, ...shot.items].map((tag) => (
                                                <span key={tag} className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                        <div className="text-[11px] text-stone-400 dark:text-stone-500">{t("copyVideo.refHint", { n: referencesForShot(shot).length })}</div>
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
            <input
                ref={uploadInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                    applyUploadedImage(event.target.files?.[0] ?? null);
                    event.target.value = "";
                }}
            />

            <Drawer title={t("copyVideo.history")} placement="right" width={380} open={historyOpen} onClose={() => setHistoryOpen(false)}>
                <div className="flex flex-col gap-2">
                    {historyLoading && !historyList.length ? (
                        <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
                            <Loader2 className="size-4 animate-spin" />
                            {t("common.loading")}
                        </div>
                    ) : null}
                    {!historyLoading && !historyList.length ? <div className="py-6 text-sm text-stone-500 dark:text-stone-400">{t("copyVideo.historyEmpty")}</div> : null}
                    {historyList.map((item) => (
                        <div
                            key={item.id}
                            className={[
                                "flex items-center justify-between gap-2 rounded-xl border p-3 transition",
                                item.id === historyId ? "border-stone-400 bg-stone-50 dark:border-stone-600 dark:bg-stone-900" : "border-stone-200 hover:border-stone-300 dark:border-stone-800",
                            ].join(" ")}
                        >
                            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void loadHistory(item.id)}>
                                <div className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{item.title || t("copyVideo.untitled")}</div>
                                <div className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                                    {formatHistoryTime(item.updated_at || item.created_at)} · {t("copyVideo.historyShots", { count: item.shot_count })}
                                </div>
                            </button>
                            <Popconfirm title={t("copyVideo.historyDeleteConfirm")} okText={t("common.delete")} cancelText={t("common.cancel")} onConfirm={() => void removeHistory(item.id)}>
                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} />
                            </Popconfirm>
                        </div>
                    ))}
                </div>
            </Drawer>
        </main>
    );
}
