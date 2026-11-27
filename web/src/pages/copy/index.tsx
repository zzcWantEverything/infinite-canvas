import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Progress, type InputRef } from "antd";
import {
    Check,
    ChevronDown,
    Clapperboard,
    Download,
    History,
    Layers,
    Loader2,
    Map as MapIcon,
    Package,
    Palette,
    Pencil,
    Plus,
    Replace,
    Save,
    Sparkles,
    Trash2,
    Upload,
    User,
    Wand2,
    X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetCard } from "@/pages/copy/components/asset-card";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CopyReplaceBar } from "@/pages/copy/components/copy-replace-bar";
import { ShotTable } from "@/pages/copy/components/shot-table";
import { CharacterStyleSelect, CopyImageSettingsBar, CopyVideoSettingsBar, createCopyGenSettings, type CopyGenSettings, type ShotOverride } from "@/components/copy/copy-settings-panel";
import type { CopyMedia } from "@/components/copy/types";
import { characterImagePrompt, characterStyleOf, itemImagePrompt, sceneImagePrompt } from "@/config/character-styles";
import { videoModelCapability } from "@/config/video-models";
import { computeMediaSize } from "@/lib/media-size";
import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    analyzeOverview,
    analyzeShotsWindow,
    buildFrameGrid,
    composeShotImagePrompt,
    extractAudioWav,
    extractSceneFrames,
    formatTranscript,
    generateItemImage,
    generateShotImage,
    generateShotVideo,
    mergeBatchAnalyses,
    mergeCasting,
    dropRepeatedDialogue,
    outlineForWindow,
    parseTranscript,
    planAnalysisWindows,
    renameAssetInShots,
    replaceTermsInAnalysis,
    resolveShotBoundAssets,
    sampleFrames,
    shotPrompt,
    shotStartSeconds,
    spreadTranscript,
    sanitizeItemIds,
    syncShotAssetsFromPrompt,
    transcribeAudio,
    transcriptForWindow,
    unbindAssetInShot,
    type CopyAnalysis,
    type CopyAssetSection,
    type CopyFrame,
    type CopyItem,
    type CopyResolvedAsset,
    type CopyShot,
    type CopyShotUnitTarget,
    type ShotReferenceBinding,
    type TermReplaceOptions,
    type TermReplaceRule,
} from "@/services/api/copy-video";
import { createCopyHistory, deleteCopyHistory, formatHistoryTime, getCopyHistory, listCopyHistory, updateCopyHistory, type CopyHistorySummary } from "@/services/api/copy-history";
import { awaitCloudUploads, serializeDoc } from "@/services/canvas-cloud";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
/** 分析用的多模态模型：zcapi(OpenAI 渠道) 的 gpt 系列，支持图片输入。 */
const ANALYSIS_MODEL = "gpt-6-sol";

type Section = "roles" | "scenes" | "items";
type BatchKind = "" | "asset-image" | "shot-image" | "shot-video" | "download";

/** 简单并发队列：批量生图/生视频时同时最多跑 N 个，避免把上游和本机同时打满。 */
async function runQueue<T>(tasks: T[], worker: (task: T) => Promise<void>, concurrency = 2) {
    const queue = [...tasks];
    await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            for (;;) {
                const next = queue.shift();
                if (!next) return;
                await worker(next);
            }
        }),
    );
}

export default function CopyVideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ kind: "asset" | "storyboard"; id: string } | null>(null);
    const historyRef = useRef<HTMLDivElement>(null);
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);

    const [file, setFile] = useState<File | null>(null);
    const [videoUrl, setVideoUrl] = useState("");
    const [videoDuration, setVideoDuration] = useState<number | null>(null);
    const [shotUnitTarget, setShotUnitTarget] = useState<CopyShotUnitTarget | null>(15);
    const [analysis, setAnalysis] = useState<CopyAnalysis | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    // 只暴露一个百分比进度条：分批/抽帧/转写这些过程对用户没意义。
    const [analysisPercent, setAnalysisPercent] = useState(0);
    // 分析阶段文案：抽帧 / 转写 / 资产表 / 第几窗细化
    const [analysisStage, setAnalysisStage] = useState<"" | "frames" | "transcribe" | "overview" | "window">("");
    const [windowProgress, setWindowProgress] = useState<{ current: number; total: number } | null>(null);
    const [error, setError] = useState("");
    // 角色/场景/物品 → 生成图；分镜 → 原视频分镜图 / 图片预览 / 视频预览
    const [itemImages, setItemImages] = useState<Record<string, CopyMedia>>({});
    const [itemStatus, setItemStatus] = useState<Record<string, string>>({});
    const [storyboards, setStoryboards] = useState<Record<string, CopyMedia>>({});
    const [shotImages, setShotImages] = useState<Record<string, CopyMedia>>({});
    const [shotImageStatus, setShotImageStatus] = useState<Record<string, string>>({});
    const [shotVideos, setShotVideos] = useState<Record<string, CopyMedia>>({});
    // 每个分镜的生成历史：最新在前，最多保留 12 条；当前展示的仍是 shotImages / shotVideos。
    const [shotImageHistory, setShotImageHistory] = useState<Record<string, CopyMedia[]>>({});
    const [shotVideoHistory, setShotVideoHistory] = useState<Record<string, CopyMedia[]>>({});
    const [mediaHistory, setMediaHistory] = useState<{ kind: "image" | "video"; shotId: string } | null>(null);
    // 点图看大图 / 从「我的素材」选图
    const [previewUrl, setPreviewUrl] = useState("");
    const [libraryTarget, setLibraryTarget] = useState<string | null>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [shotStatus, setShotStatus] = useState<Record<string, string>>({});
    const [shotOverrides, setShotOverrides] = useState<Record<string, ShotOverride>>({});
    const [batchRunning, setBatchRunning] = useState<BatchKind>("");
    // 当前编辑中的历史记录：分析完自动建一条，之后编辑/生成都更新它。
    const [historyId, setHistoryId] = useState<number | null>(null);
    const historyIdRef = useRef<number | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyList, setHistoryList] = useState<CopyHistorySummary[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [sourceMeta, setSourceMeta] = useState<{
        sceneCount?: number;
        frameCount?: number;
        duration?: number;
        /** 转写诊断：字符数 / 解析出的时间戳段数 / 开头片段 / 失败原因 */
        transcriptChars?: number;
        transcriptSegments?: number;
        transcriptHead?: string;
        transcriptError?: string;
    } | null>(null);
    // 云端保存要等素材上传落地，串行化避免同一份记录并发写。
    const savingRef = useRef(false);
    const [saving, setSaving] = useState(false);
    const sessionToken = useUserStore((state) => state.session?.token || "");

    // 弹窗：角色/场景/物品编辑、分镜详情、风格内联编辑
    const [assetDraft, setAssetDraft] = useState<{ section: Section; id: string | null; name: string; description: string; voice: string } | null>(null);
    const [shotDraft, setShotDraft] = useState<CopyShot | null>(null);
    const [styleEditing, setStyleEditing] = useState(false);
    const [styleDraft, setStyleDraft] = useState("");
    const [spaceEditing, setSpaceEditing] = useState(false);
    const [spaceDraft, setSpaceDraft] = useState("");
    const [replaceUndo, setReplaceUndo] = useState<CopyAnalysis | null>(null);
    const replaceBarRef = useRef<HTMLDivElement>(null);
    const replaceInputRef = useRef<InputRef>(null);

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
            // 隔离全局生图系统提示词，避免用户画布预设（如多视图/设定图）污染复刻页面分镜或物品生图
            systemPrompt: "",
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

    // 角色图按「角色样式」的画幅出图（四视图是 3:4）；场景/物品沿用统一参数。
    const activeCharacterStyle = characterStyleOf(genSettings.characterStyle);
    const imageConfigFor = (section: Section) =>
        section === "roles" ? { ...imageConfig, size: computeMediaSize(genSettings.imageScale, activeCharacterStyle.aspectRatio) } : imageConfig;

    /** 生图提示词：角色走角色样式模板；场景与物品走各自独立的单图模板，严禁套用人物多视图/细节框样式。 */
    const itemPrompt = (item: CopyItem, section: Section) => {
        const filmStyle = analysis?.style || "";
        if (section === "roles") return characterImagePrompt({ name: item.name, description: item.description, filmStyle, styleId: genSettings.characterStyle });
        if (section === "scenes") return sceneImagePrompt({ name: item.name, description: item.description, filmStyle, spaceContext: analysis?.spaceContext });
        return itemImagePrompt({ name: item.name, description: item.description, filmStyle });
    };

    const videoCapability = videoModelCapability(genSettings.videoModel);    const resolutionOptions = useMemo(() => {
        const tiers = videoCapability?.resolutions?.length ? videoCapability.resolutions : ["480", "720", "1080"];
        return tiers.map((tier) => ({ value: tier, label: `${tier}P` }));
    }, [videoCapability]);
    const secondsOptions = useMemo(() => {
        const { min, max, step } = videoCapability?.seconds ?? { min: 4, max: 30, step: 1 };
        const stride = step && step > 0 ? step : 1;
        const list: { value: string; label: string }[] = [];
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [{ value: "5", label: "5s" }];
        for (let seconds = min; seconds <= max; seconds += stride) list.push({ value: String(seconds), label: `${seconds}s` });
        return list;
    }, [videoCapability]);

    /**
     * 分镜自己的时长 → 模型支持的档位。面板选「按分镜时长」时用这个，
     * 复刻出来的节奏才和原片一致（统一 5 秒会把快切镜头全拖成慢镜头）。
     */
    const shotSeconds = (shot: CopyShot) => {
        const override = shotOverrides[shot.id]?.seconds;
        if (override) return override;
        if (genSettings.videoSeconds !== "auto") return genSettings.videoSeconds;
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
        if (!Number.isFinite(seconds)) return "5";
        const { min, max, step } = videoCapability?.seconds ?? { min: 4, max: 30, step: 1 };
        const stride = step && step > 0 ? step : 1;
        const snapped = Math.round(seconds / stride) * stride;
        return String(Math.min(max, Math.max(min, snapped)));
    };

    const videoConfigFor = (shot: CopyShot) => ({
        ...videoConfig,
        videoSeconds: shotSeconds(shot),
        vquality: shotOverrides[shot.id]?.resolution || genSettings.videoResolution,
    });

    useEffect(
        () => () => {
            if (videoUrl) URL.revokeObjectURL(videoUrl);
        },
        [videoUrl],
    );

    // 点历史项目下拉以外的地方收起面板
    useEffect(() => {
        if (!historyOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [historyOpen]);

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
        setVideoDuration(null);
        setShotUnitTarget(15);
        setAnalysis(null);
        setError("");
    };

    /** 每个分镜自动配一张「原视频分镜图」：取起始时间最近的抽帧，落本地素材库后写 storageKey。 */
    const attachStoryboards = async (result: CopyAnalysis, frames: CopyFrame[], aspect: number) => {
        // 「原视频分镜图」是一整段的多帧拼图（和参考产品一致），不是一个起始帧：
        // 取该单元时间范围内的抽帧，最多 9 格打在带时间标注的宫格里。
        for (const shot of result.shots.slice(0, 60)) {
            const start = shotStartSeconds(shot.start);
            const end = shotStartSeconds(shot.end) || start;
            const inside = frames.filter((frame) => frame.time >= start - 0.05 && frame.time <= end + 0.05);
            const picked = sampleFrames(inside.length ? inside : frames, 9);
            if (!picked.length) continue;
            try {
                const grid = picked.length > 1 ? await buildFrameGrid(picked, aspect) : picked[0].dataUrl;
                const media = await uploadMediaFile(grid, "image");
                setStoryboards((prev) => ({ ...prev, [shot.id]: { url: media.url, storageKey: media.storageKey } }));
            } catch {
                // 单张拼图上传失败不影响分析结果
            }
        }
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
            // 1) 抽帧：上限 120 帧（≤90s 按 0.5 秒一帧打底 + 切点首帧），覆盖快剪与短时连续弹字。
            setAnalysisStage("frames");
            setAnalysisPercent(4);
            const { frames, meta } = await extractSceneFrames(file, 120);
            setAnalysisPercent(10);
            // 2) 音轨转写：失败降级为无台词，不阻塞分析。带时间戳的转写会按时间窗对齐到节拍。
            setAnalysisStage("transcribe");
            let rawTranscript = "";
            let transcriptError = "";
            try {
                const audio = await extractAudioWav(file);
                if (!audio) transcriptError = "音轨解码失败（编码不被浏览器支持）";
                else rawTranscript = await transcribeAudio(config.baseUrl, sessionToken, audio.blob);
            } catch (e) {
                transcriptError = e instanceof Error ? e.message : "转写失败";
            }
            // 腾讯有时整段只返回一句、甚至没有时间戳：能解析就按句拆，解析不了就按句均分到全片时长。
            let segments = parseTranscript(rawTranscript);
            if (!segments.length && rawTranscript.trim()) segments = spreadTranscript(rawTranscript, meta.duration);
            setAnalysisPercent(15);
            const effectiveTarget: CopyShotUnitTarget | undefined =
                shotUnitTarget === 30 && meta.duration <= 15 ? 15 : (shotUnitTarget ?? undefined);
            // 3) 第一步：全片稀疏宫格 → 资产表（角色/场景/物品 + 声线）+ 分镜大纲 + 风格（长片抽 36 帧降低遗漏）。
            setAnalysisStage("overview");
            const overviewFrames = sampleFrames(frames, meta.duration > 60 ? 36 : 24);
            const overviewGrid = await buildFrameGrid(overviewFrames, meta.width / meta.height);
            const overview = await analyzeOverview(
                overviewGrid,
                meta,
                ANALYSIS_MODEL,
                sessionToken,
                formatTranscript(rawTranscript, segments),
                undefined,
                effectiveTarget,
            );
            setAnalysisPercent(25);
            // 4) 第二步：按大纲 + 切点/句末边界智能切窗，串行——后面的窗要吃前面窗定下的资产、场景与收尾状态。
            const windows = planAnalysisWindows(frames, meta.duration, {
                outline: overview.outline,
                cuts: meta.cuts,
                segments,
                targetUnitSeconds: effectiveTarget,
                maxWindowSeconds: effectiveTarget ?? 15,
                minWindowSeconds: effectiveTarget === 30 ? 18 : effectiveTarget === 15 ? 10 : 5,
                maxCells: effectiveTarget === 30 ? 24 : 18,
            });
            let result: CopyAnalysis | null = null;
            let casting = { roles: overview.roles, scenes: overview.scenes, items: overview.items };
            let previousEndState = "";
            let previousScene = "";
            // 已说过的台词：传给下一窗，避免同一句被写两遍；合并后再兜一层去重。
            const usedDialogue: string[] = [];
            for (let index = 0; index < windows.length; index += 1) {
                setAnalysisStage("window");
                setWindowProgress({ current: index + 1, total: windows.length });
                setAnalysisPercent(25 + Math.round((index / windows.length) * 68));
                const { start: startTime, end: endTime, frames: windowFrames } = windows[index];
                const grid = await buildFrameGrid(windowFrames, meta.width / meta.height);
                let partial: CopyAnalysis;
                try {
                    partial = await analyzeShotsWindow(grid, meta, ANALYSIS_MODEL, sessionToken, {
                        index: index + 1,
                        total: windows.length,
                        startTime,
                        endTime,
                        cuts: (meta.cuts ?? []).filter((time) => time >= startTime - 0.01 && time <= endTime + 0.01),
                        targetUnitSeconds: effectiveTarget,
                        casting,
                        // 按区间重叠 + 前窗未说完/待衔接台词分发，避免跨窗或时间戳漂移吞掉整段对白
                        transcript: transcriptForWindow(segments, startTime, endTime, index === windows.length - 1, usedDialogue.join("\n")),
                        outline: outlineForWindow(overview.outline, startTime, endTime),
                        textStyle: overview.textStyle,
                        spaceContext: overview.spaceContext,
                        previousScene,
                        previousDialogue: usedDialogue.slice(-3).join("；").slice(0, 600),
                        previousEndState,
                    });
                } catch (windowError) {
                    // 已经拿到部分结果就别整单作废：后面几窗失败时提示一句，保住前面分析好的单元。
                    if (!result) throw windowError;
                    message.warning(t("copyVideo.batchPartial", { current: index + 1, total: windows.length }));
                    break;
                }
                casting = mergeCasting(casting, partial);
                result = result ? mergeBatchAnalyses([result, partial]) : partial;
                for (const shot of partial.shots) {
                    const line = shot.dialogue?.trim();
                    if (line && line !== "台词待核对") usedDialogue.push(line);
                }
                const last = partial.shots[partial.shots.length - 1];
                if (last) {
                    const promptLines = last.videoPrompt
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean);
                    previousEndState = promptLines[promptLines.length - 1] || last.description;
                    previousScene = last.scenes.join("、");
                }
                setAnalysisPercent(25 + Math.round(((index + 1) / windows.length) * 68));
            }
            if (!result) throw new Error(t("copyVideo.analyzeFailed"));
            const mergedCasting = dropRepeatedDialogue({
                ...result,
                title: result.title && result.title !== "爆款转绘" ? result.title : overview.title,
                ratio: result.ratio || overview.ratio,
                style: result.style || overview.style,
                spaceContext: result.spaceContext || overview.spaceContext || "",
                roles: casting.roles,
                scenes: casting.scenes,
                items: casting.items,
            });
            const finalResult: CopyAnalysis = {
                ...mergedCasting,
                shots: syncShotAssetsFromPrompt(mergedCasting.shots, mergedCasting),
            };
            setAnalysis(finalResult);
            setReplaceUndo(null);
            // 转写诊断留在记录里：下次「台词待核对」时能直接看出是没声音、解码失败还是格式没解析出来。
            setSourceMeta({
                sceneCount: meta.sceneCount,
                frameCount: frames.length,
                duration: Number(meta.duration.toFixed(1)),
                transcriptChars: rawTranscript.length,
                transcriptSegments: segments.length,
                transcriptHead: rawTranscript.slice(0, 300),
                transcriptError,
            });
            // 新的一次分析 → 新的一条历史，之前的记录保持原样。
            syncHistoryId(null);
            setStoryboards({});
            setShotImages({});
            setShotVideos({});
            setShotOverrides({});
            setItemImages({});
            setShotImageHistory({});
            setShotVideoHistory({});
            // 原视频分镜图在后台补齐，先让用户看到分析结果。
            void attachStoryboards(finalResult, frames, meta.width / meta.height);
            message.success(t("copyVideo.analyzed"));
        } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") return;
            setError(e instanceof Error ? e.message : t("copyVideo.analyzeFailed"));
        } finally {
            setAnalyzing(false);
            setAnalysisPercent(0);
            setAnalysisStage("");
            setWindowProgress(null);
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
        setAnalysis((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                shots: prev.shots.map((shot) => {
                    if (shot.id !== id) return shot;
                    const merged = { ...shot, ...patch };
                    return typeof patch.videoPrompt === "string" ? syncShotAssetsFromPrompt([merged], prev)[0] : merged;
                }),
            };
        });
    };

    const bindShotAsset = (shotId: string, section: CopyAssetSection, name: string) => {
        setAnalysis((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                shots: prev.shots.map((shot) => {
                    if (shot.id !== shotId) return shot;
                    const existing = shot[section] ?? [];
                    if (existing.includes(name)) return shot;
                    return { ...shot, [section]: [...existing, name] };
                }),
            };
        });
    };

    const unbindShotAsset = (shotId: string, section: CopyAssetSection, name: string) => {
        setAnalysis((prev) => {
            if (!prev) return prev;
            const allNames = [...prev.roles, ...prev.scenes, ...prev.items].map((item) => item.name);
            return {
                ...prev,
                shots: prev.shots.map((shot) => (shot.id === shotId ? unbindAssetInShot(shot, section, name, allNames) : shot)),
            };
        });
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
                              videoPrompt: "",
                              shotSize: "",
                              cameraAngle: "",
                              cameraMove: "",
                              description: "",
                              performance: "",
                              sound: "",
                              dialogue: "",
                              onScreenText: "",
                              imagePrompt: "",
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

    const patchOverride = (id: string, patch: ShotOverride) => setShotOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

    // 自己上传参考图：覆盖 AI 生成的那张，后续生视频会用它当参考。
    const pickItemImage = (id: string) => {
        uploadTargetRef.current = { kind: "asset", id };
        uploadInputRef.current?.click();
    };

    const pickStoryboard = (id: string) => {
        uploadTargetRef.current = { kind: "storyboard", id };
        uploadInputRef.current?.click();
    };

    const applyUploadedImage = (file: File | null) => {
        const target = uploadTargetRef.current;
        uploadTargetRef.current = null;
        if (!file || !target) return;
        void uploadMediaFile(file, "image").then((media) => {
            const value = { url: media.url, storageKey: media.storageKey };
            if (target.kind === "asset") setItemImages((prev) => ({ ...prev, [target.id]: value }));
            else setStoryboards((prev) => ({ ...prev, [target.id]: value }));
        });
    };

    const toRefImage = (id: string, name: string, media: CopyMedia): ReferenceImage => ({
        id,
        name,
        type: "image/png",
        url: media.url,
        dataUrl: media.url,
        storageKey: media.storageKey || undefined,
    });

    const maxVideoRefs = useMemo(() => {
        if (videoCapability?.maxImages && videoCapability.maxImages > 0) return Math.min(videoCapability.maxImages, 9);
        return resolveModelRequestConfig(videoConfig, genSettings.videoModel).apiFormat === "gemini" ? 4 : 1;
    }, [videoCapability, videoConfig, genSettings.videoModel]);

    /**
     * 单一真源：统一算出本分镜「绑定资产 + 实际上传参考图 + 1-based 图片N 映射」。
     * 生视频、UI 状态徽标与复制描述词都共用它，保证提示词编号与上传参考图顺序 100% 一致。
     */
    const resolveShotVideoRefs = (shot: CopyShot): { refs: ReferenceImage[]; bindings: ShotReferenceBinding[]; boundAssets: CopyResolvedAsset[] } => {
        const boundAssets = analysis ? resolveShotBoundAssets(shot, analysis) : [];
        const entries: Array<{ ref: ReferenceImage; kind: ShotReferenceBinding["kind"]; id: string; name: string }> = [];
        const frame = shotImages[shot.id];
        if (frame?.url) {
            const name = `${t("copyVideo.shot")}${shot.start || ""}`;
            entries.push({
                ref: toRefImage(`frame-${shot.id}`, name, frame),
                kind: "storyboard",
                id: `frame-${shot.id}`,
                name,
            });
        }
        for (const asset of boundAssets) {
            const media = itemImages[asset.id];
            if (!media?.url) continue;
            entries.push({
                ref: toRefImage(asset.id, asset.name, media),
                kind: asset.kind,
                id: asset.id,
                name: asset.name,
            });
        }
        if (!boundAssets.length && !entries.length && analysis) {
            const appendFallback = (items: CopyItem[], kind: "role" | "scene") => {
                for (const item of items) {
                    const media = itemImages[item.id];
                    if (!media?.url) continue;
                    entries.push({ ref: toRefImage(item.id, item.name, media), kind, id: item.id, name: item.name });
                }
            };
            appendFallback(analysis.roles, "role");
            appendFallback(analysis.scenes, "scene");
        }
        const limited = entries.slice(0, maxVideoRefs);
        return {
            refs: limited.map((entry) => entry.ref),
            bindings: limited.map((entry, idx) => ({
                index: idx + 1,
                name: entry.name,
                kind: entry.kind,
                id: entry.id,
            })),
            boundAssets,
        };
    };

    /**
     * 分镜生图参考：优先把「原视频分镜图」放在最前面对齐构图和机位，
     * 紧跟该镜绑定的角色/场景/物品图（带上 storageKey 防远程读图失败）。
     */
    const imageRefsForShot = (shot: CopyShot): ReferenceImage[] => {
        const refs: ReferenceImage[] = [];
        const storyboard = storyboards[shot.id];
        if (storyboard?.url) refs.push(toRefImage(`story-${shot.id}`, `${t("copyVideo.shot")}${shot.start || ""}`, storyboard));
        if (analysis) {
            for (const asset of resolveShotBoundAssets(shot, analysis)) {
                const media = itemImages[asset.id];
                if (media?.url) refs.push(toRefImage(asset.id, asset.name, media));
            }
            if (refs.length === (storyboard?.url ? 1 : 0)) {
                for (const item of [...analysis.scenes, ...analysis.roles]) {
                    const media = itemImages[item.id];
                    if (media?.url) refs.push(toRefImage(item.id, item.name, media));
                }
            }
        }
        return refs.slice(0, 6);
    };

    const runItemImage = async (item: CopyItem, section: Section = "items") => {
        setItemStatus((prev) => ({ ...prev, [item.id]: "running" }));
        try {
            const dataUrl = await generateItemImage(imageConfigFor(section), itemPrompt(item, section));
            // 生成结果先落到本地素材库（随后台同步上云）：历史记录只存 storageKey，
            // 否则一张几 MB 的 base64 会把记录撑爆。
            const media = await uploadMediaFile(dataUrl, "image");
            setItemImages((prev) => ({ ...prev, [item.id]: { url: media.url, storageKey: media.storageKey } }));
            setItemStatus((prev) => ({ ...prev, [item.id]: "done" }));
        } catch (e) {
            setItemStatus((prev) => ({ ...prev, [item.id]: "failed" }));
            if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : t("copyVideo.imageFailed"));
        }
    };

    const runShotImage = async (shot: CopyShot) => {
        setShotImageStatus((prev) => ({ ...prev, [shot.id]: "running" }));
        try {
            const dataUrl = await generateShotImage(imageConfig, shot, imageRefsForShot(shot), analysis?.style || "");
            const media = await uploadMediaFile(dataUrl, "image");
            const entry = { url: media.url, storageKey: media.storageKey };
            setShotImages((prev) => ({ ...prev, [shot.id]: entry }));
            const shotIndex = analysis ? analysis.shots.findIndex((item) => item.id === shot.id) : -1;
            addAsset({
                kind: "image",
                title: `${t("copyVideo.shot")} ${String(shotIndex + 1).padStart(2, "0")}`,
                coverUrl: media.url,
                tags: [],
                source: "复刻视频",
                data: { dataUrl: media.url, storageKey: media.storageKey, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType },
            });
            setShotImageHistory((prev) => ({ ...prev, [shot.id]: [entry, ...(prev[shot.id] || [])].slice(0, 12) }));
            setShotImageStatus((prev) => ({ ...prev, [shot.id]: "done" }));
        } catch (e) {
            setShotImageStatus((prev) => ({ ...prev, [shot.id]: "failed" }));
            if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : t("copyVideo.imageFailed"));
        }
    };

    const runShotVideo = async (shot: CopyShot) => {
        setShotStatus((prev) => ({ ...prev, [shot.id]: "running" }));
        try {
            const { refs, bindings } = resolveShotVideoRefs(shot);
            const media = await generateShotVideo(videoConfigFor(shot), shot, refs, analysis?.style || "", undefined, {
                roles: analysis?.roles,
                spaceContext: analysis?.spaceContext,
                referenceBindings: bindings,
            });
            const entry = { url: media.url, storageKey: media.storageKey };
            setShotVideos((prev) => ({ ...prev, [shot.id]: entry }));
            setShotVideoHistory((prev) => ({ ...prev, [shot.id]: [entry, ...(prev[shot.id] || [])].slice(0, 12) }));
            setShotStatus((prev) => ({ ...prev, [shot.id]: "done" }));
        } catch (e) {
            setShotStatus((prev) => ({ ...prev, [shot.id]: "failed" }));
            if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : t("copyVideo.videoFailed"));
        }
    };

    // 批量生成：角色/场景/物品图、分镜图、分镜视频
    const runBatch = async (kind: "asset-image" | "shot-image" | "shot-video") => {
        if (!analysis || batchRunning) return;
        setBatchRunning(kind);
        try {
            if (kind === "asset-image") {
                const assets: { item: CopyItem; section: Section }[] = [
                    ...analysis.roles.map((item) => ({ item, section: "roles" as Section })),
                    ...analysis.scenes.map((item) => ({ item, section: "scenes" as Section })),
                    ...analysis.items.map((item) => ({ item, section: "items" as Section })),
                ];
                await runQueue(assets, (asset) => runItemImage(asset.item, asset.section), 2);
            } else if (kind === "shot-image") await runQueue(analysis.shots, runShotImage, 2);
            else await runQueue(analysis.shots, runShotVideo, 2);
        } finally {
            setBatchRunning("");
        }
    };

    /** 批量补全图片描述词：模型漏写时按分镜字段拼一段，用户还可以再改。 */
    const fillImagePrompts = () => {
        if (!analysis) return;
        const missing = analysis.shots.filter((shot) => !String(shot.imagePrompt || "").trim());
        if (!missing.length) {
            message.info(t("copyVideo.imagePromptReady"));
            return;
        }
        setAnalysis((prev) =>
            prev
                ? {
                      ...prev,
                      shots: prev.shots.map((shot) => (String(shot.imagePrompt || "").trim() ? shot : { ...shot, imagePrompt: composeShotImagePrompt(shot, prev) })),
                  }
                : prev,
        );
        message.success(t("copyVideo.imagePromptFilled", { count: missing.length }));
    };

    const downloadShotVideo = async (shot: CopyShot) => {
        const url = shotVideos[shot.id]?.url;
        if (!url) return;
        try {
            const blob = await fetch(url).then((response) => response.blob());
            const anchor = document.createElement("a");
            anchor.href = URL.createObjectURL(blob);
            const index = analysis ? analysis.shots.findIndex((item) => item.id === shot.id) : -1;
            anchor.download = `${t("copyVideo.shot")}-${String(index + 1).padStart(2, "0")}.mp4`;
            anchor.click();
            URL.revokeObjectURL(anchor.href);
        } catch (e) {
            message.error(e instanceof Error ? e.message : t("copyVideo.downloadFailed"));
        }
    };

    const downloadVideos = async () => {
        if (!analysis || batchRunning) return;
        const completed = analysis.shots.map((shot, index) => ({ shot, index })).filter((entry) => shotVideos[entry.shot.id]?.url);
        if (!completed.length) {
            message.info(t("copyVideo.noVideos"));
            return;
        }
        setBatchRunning("download");
        try {
            for (const { shot, index } of completed) {
                const url = shotVideos[shot.id].url;
                const blob = await fetch(url).then((response) => response.blob());
                const anchor = document.createElement("a");
                anchor.href = URL.createObjectURL(blob);
                anchor.download = `${t("copyVideo.shot")}-${String(index + 1).padStart(2, "0")}.mp4`;
                anchor.click();
                URL.revokeObjectURL(anchor.href);
            }
        } catch (e) {
            message.error(e instanceof Error ? e.message : t("copyVideo.downloadFailed"));
        } finally {
            setBatchRunning("");
        }
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
        setHistoryOpen((open) => !open);
        if (!historyOpen) void refreshHistoryList();
    };

    /** 把当前编辑内容存成一条历史（首次创建，之后更新同一条）。 */
    const persistHistory = async () => {
        if (!analysis || !sessionToken || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
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
                shotImages,
                shotVideos,
                shotImageHistory,
                shotVideoHistory,
                storyboards,
                shotOverrides,
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
            setSaving(false);
        }
    };

    // 分析结果、参数、素材任一变化 → 1.5 秒后同步到云端历史。
    useEffect(() => {
        if (!analysis || !sessionToken) return;
        const timer = window.setTimeout(() => void persistHistory(), 1500);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analysis, genSettings, itemImages, shotVideos, shotImages, storyboards, shotOverrides, sessionToken]);

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
                shotImages?: Record<string, CopyMedia>;
                shotImageHistory?: Record<string, CopyMedia[]>;
                shotVideoHistory?: Record<string, CopyMedia[]>;
                storyboards?: Record<string, CopyMedia>;
                shotOverrides?: Record<string, ShotOverride>;
                source?: { sceneCount?: number; frameCount?: number } | null;
            };
            if (!doc.analysis) throw new Error(t("copyVideo.historyBroken"));
            // 老记录的 id 可能是撞车的（三个分区共用 `item-<stamp>-<index>`），载入时统一重写，
            // 素材表按映射跟着搬，否则一张图会同时出现在角色/场景/物品里。
            const sanitized = sanitizeItemIds(doc.analysis);
            // 老记录没有 style / imagePrompt 字段：载入时补空串，后面的编辑和生成都按存在处理。
            const normalized: CopyAnalysis = {
                ...sanitized.analysis,
                style: sanitized.analysis.style || "",
                spaceContext: sanitized.analysis.spaceContext || "",
                shots: (sanitized.analysis.shots || []).map((shot) => ({ ...shot, imagePrompt: shot.imagePrompt || "", videoPrompt: shot.videoPrompt || "" })),
            };
            setAnalysis(normalized);
            setReplaceUndo(null);
            setSourceMeta(doc.source ?? null);
            if (doc.settings) setGenSettings({ ...createCopyGenSettings(config), ...doc.settings });
            const remapMedia = async (map?: Record<string, CopyMedia>) => {
                const moved: Record<string, CopyMedia> = {};
                const resolved = await resolveMediaMap(map);
                for (const [oldId, media] of Object.entries(resolved)) moved[sanitized.remap[oldId] ?? oldId] = media;
                return moved;
            };
            const resolveHistory = async (map?: Record<string, CopyMedia[]>) => {
                const out: Record<string, CopyMedia[]> = {};
                for (const [oldId, list] of Object.entries(map || {})) {
                    const resolved: CopyMedia[] = [];
                    for (const media of list) {
                        if (!media?.storageKey) continue;
                        const url = await resolveMediaUrl(media.storageKey, "").catch(() => "");
                        if (url) resolved.push({ url, storageKey: media.storageKey });
                    }
                    if (resolved.length) out[sanitized.remap[oldId] ?? oldId] = resolved;
                }
                return out;
            };
            setItemImages(await remapMedia(doc.itemImages));
            const videos = await remapMedia(doc.shotVideos);
            const images = await remapMedia(doc.shotImages);
            const videoHistory = await resolveHistory(doc.shotVideoHistory);
            const imageHistory = await resolveHistory(doc.shotImageHistory);
            // 老记录只有当前那一张：补成一条历史，历史面板里也能看到。
            for (const [shotId, media] of Object.entries(images)) if (!imageHistory[shotId]) imageHistory[shotId] = [media];
            for (const [shotId, media] of Object.entries(videos)) if (!videoHistory[shotId]) videoHistory[shotId] = [media];
            setShotVideos(videos);
            setShotImages(images);
            setShotVideoHistory(videoHistory);
            setShotImageHistory(imageHistory);
            setStoryboards(await remapMedia(doc.storyboards));
            setShotOverrides(doc.shotOverrides ?? {});
            setItemStatus({});
            setShotStatus({});
            setShotImageStatus({});
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

    const openAddAsset = (section: Section) => setAssetDraft({ section, id: null, name: "", description: "", voice: "" });
    const openEditAsset = (section: Section, item: CopyItem) => setAssetDraft({ section, id: item.id, name: item.name, description: item.description, voice: item.voice || "" });
    const commitAsset = () => {
        if (!assetDraft) return;
        const name = assetDraft.name.trim();
        const description = assetDraft.description.trim();
        if (!name) {
            message.warning(t("copyVideo.nameRequired"));
            return;
        }
        const voice = assetDraft.section === "roles" ? assetDraft.voice.trim() : "";
        if (assetDraft.id) {
            const targetId = assetDraft.id;
            const targetSection = assetDraft.section;
            setAnalysis((prev) => {
                if (!prev) return prev;
                const oldItem = prev[targetSection].find((item) => item.id === targetId);
                const allNames = [...prev.roles, ...prev.scenes, ...prev.items].map((item) => item.name);
                const updatedSection = prev[targetSection].map((item) =>
                    item.id === targetId ? { ...item, name, description, ...(targetSection === "roles" ? { voice } : {}) } : item,
                );
                const updatedShots =
                    oldItem && oldItem.name && oldItem.name !== name
                        ? renameAssetInShots(prev.shots, targetSection, oldItem.name, name, allNames)
                        : prev.shots;
                return { ...prev, [targetSection]: updatedSection, shots: updatedShots };
            });
        } else {
            const item: CopyItem = { id: `${assetDraft.section}-${Date.now()}`, name, description, ...(assetDraft.section === "roles" ? { voice } : {}) };
            setAnalysis((prev) => (prev ? { ...prev, [assetDraft.section]: [...prev[assetDraft.section], item] } : prev));
        }
        setAssetDraft(null);
    };

    const saveStyle = () => {
        setAnalysis((prev) => (prev ? { ...prev, style: styleDraft.trim() } : prev));
        setStyleEditing(false);
    };

    const saveSpaceContext = () => {
        setAnalysis((prev) => (prev ? { ...prev, spaceContext: spaceDraft.trim() } : prev));
        setSpaceEditing(false);
    };

    const applyTermReplace = (rules: TermReplaceRule[], options: TermReplaceOptions) => {
        if (!analysis) return;
        const { analysis: next, stats } = replaceTermsInAnalysis(analysis, rules, options);
        if (stats.totalMatches === 0) {
            message.info(t("copyVideo.replaceMatchNone"));
            return;
        }
        setReplaceUndo(analysis);
        setAnalysis(next);
        message.success(
            t("copyVideo.replaceSuccess", {
                total: stats.totalMatches,
                shots: stats.shotCount,
                assets: stats.assetCount,
            }),
        );
    };

    const undoTermReplace = () => {
        if (!replaceUndo) return;
        setAnalysis(replaceUndo);
        setReplaceUndo(null);
        message.success(t("copyVideo.replaceUndone"));
    };

    const focusReplaceBar = () => {
        replaceBarRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => replaceInputRef.current?.focus(), 220);
    };

    const gridClass = "grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8";
    const batchDisabled = Boolean(batchRunning);

    const historyDropdown = (
        <div className="relative" ref={historyRef}>
            <Button size="small" icon={<History className="size-3.5" />} onClick={openHistory}>
                <span className="flex items-center gap-1">
                    {t("copyVideo.historyProjects")}
                    <ChevronDown className={`size-3 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
                </span>
            </Button>
            {historyOpen ? (
                <div className="absolute left-0 top-full z-50 mt-1 max-h-96 w-80 overflow-auto rounded-xl border border-stone-200 bg-background p-2 shadow-xl dark:border-stone-700">
                    {historyLoading && !historyList.length ? (
                        <div className="flex items-center gap-2 px-3 py-4 text-xs text-stone-500">
                            <Loader2 className="size-3.5 animate-spin" />
                            {t("common.loading")}
                        </div>
                    ) : null}
                    {!historyLoading && !historyList.length ? <p className="py-4 text-center text-xs text-stone-400">{t("copyVideo.historyEmptyProject")}</p> : null}
                    {historyList.map((item) => (
                        <div
                            key={item.id}
                            className={[
                                "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800",
                                item.id === historyId ? "bg-stone-100 dark:bg-stone-800" : "",
                            ].join(" ")}
                            onClick={() => void loadHistory(item.id)}
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{item.title || t("copyVideo.untitled")}</p>
                                <p className="text-[11px] text-stone-400 dark:text-stone-500">
                                    {formatHistoryTime(item.updated_at || item.created_at)} · {t("copyVideo.historyShots", { count: item.shot_count })}
                                </p>
                            </div>
                            <Popconfirm
                                title={t("copyVideo.historyDeleteConfirm")}
                                okText={t("common.delete")}
                                cancelText={t("common.cancel")}
                                onConfirm={(event) => {
                                    event?.stopPropagation();
                                    void removeHistory(item.id);
                                }}
                            >
                                <button
                                    type="button"
                                    onClick={(event) => event.stopPropagation()}
                                    className="rounded p-1 text-stone-400 transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                                    title={t("common.delete")}
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </Popconfirm>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );

    return (
        <main className="thin-scrollbar h-full overflow-y-auto bg-transparent">
            <div className="mx-auto w-full max-w-[1720px] px-5 pb-20 pt-6 sm:px-8">
                <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-stone-950 sm:text-2xl dark:text-stone-50">
                            <Clapperboard className="size-5" />
                            {t("copyVideo.title")}
                        </h1>
                        {analysis ? (
                            <>
                                <input
                                    value={analysis.title}
                                    onChange={(event) => setAnalysis((prev) => (prev ? { ...prev, title: event.target.value } : prev))}
                                    placeholder={t("copyVideo.projectName")}
                                    className="w-40 border-b border-transparent bg-transparent px-1 py-0.5 text-sm text-stone-600 outline-none transition-colors hover:border-stone-300 focus:border-stone-500 dark:text-stone-300 dark:hover:border-stone-600"
                                />
                                <Button size="small" icon={<Save className="size-3.5" />} loading={saving} onClick={() => void persistHistory()}>
                                    {t("copyVideo.save")}
                                </Button>
                            </>
                        ) : null}
                        {historyDropdown}
                    </div>
                    {analysis ? (
                        <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={analyze} loading={analyzing}>
                            {t("copyVideo.reanalyze")}
                        </Button>
                    ) : null}
                </div>

                {!analysis ? (
                    <section className="flex flex-col gap-4 rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                        {videoUrl ? (
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_280px] lg:grid-cols-[minmax(0,1fr)_320px]">
                                <div className="relative flex items-center justify-center overflow-hidden rounded-xl bg-black">
                                    <video
                                        src={videoUrl}
                                        controls
                                        onLoadedMetadata={(event) => {
                                            const duration = event.currentTarget.duration;
                                            if (Number.isFinite(duration) && duration > 0) {
                                                setVideoDuration(duration);
                                                setShotUnitTarget((prev) => (prev === 30 && duration <= 15 ? 15 : prev));
                                            }
                                        }}
                                        className="max-h-[420px] w-full object-contain"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (videoUrl) URL.revokeObjectURL(videoUrl);
                                            setFile(null);
                                            setVideoUrl("");
                                            setVideoDuration(null);
                                            setShotUnitTarget(15);
                                        }}
                                        className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 transition hover:bg-black/80"
                                        style={{ color: "#fff" }}
                                        aria-label={t("copyVideo.remove")}
                                    >
                                        <X className="size-4" />
                                    </button>
                                </div>
                                <div className="flex flex-col justify-between gap-4 rounded-xl border border-stone-200/70 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">{t("copyVideo.segmentDuration")}</span>
                                        {videoDuration !== null ? (
                                            <span className="rounded-md bg-stone-200/70 px-2 py-0.5 text-[11px] tabular-nums text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                                {t("copyVideo.segmentVideoLength", { seconds: videoDuration.toFixed(1) })}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="flex flex-1 flex-col justify-center gap-3">
                                        {([15, 30] as const).map((sec) => {
                                            const active = shotUnitTarget === sec;
                                            const disabled = analyzing || (sec === 30 && videoDuration !== null && videoDuration <= 15);
                                            const estimate = videoDuration !== null ? Math.max(1, Math.ceil(videoDuration / sec)) : null;
                                            return (
                                                <button
                                                    key={sec}
                                                    type="button"
                                                    disabled={disabled}
                                                    aria-pressed={active}
                                                    title={sec === 30 && videoDuration !== null && videoDuration <= 15 ? t("copyVideo.segment30Disabled") : undefined}
                                                    onClick={() => setShotUnitTarget((prev) => (prev === sec ? null : sec))}
                                                    className={[
                                                        "flex min-h-[72px] w-full flex-col items-center justify-center gap-1 rounded-xl border px-4 py-3 text-center transition-all",
                                                        disabled
                                                            ? "cursor-not-allowed border-stone-200/60 bg-stone-100/50 text-stone-300 dark:border-stone-800 dark:bg-stone-900/30 dark:text-stone-600"
                                                            : active
                                                              ? "cursor-pointer border-stone-900 bg-stone-900 text-white shadow-sm dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                                                              : "cursor-pointer border-stone-200 bg-background text-stone-700 hover:border-stone-400 hover:text-stone-950 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-500 dark:hover:text-white",
                                                    ].join(" ")}
                                                >
                                                    <span className="flex items-center gap-1.5 text-lg font-semibold leading-none tracking-tight">
                                                        {active ? <Check className="size-4" /> : null}
                                                        <span>{sec}s</span>
                                                    </span>
                                                    {estimate !== null && !disabled ? (
                                                        <span className="text-xs font-normal opacity-75">{t("copyVideo.segmentEstimate", { count: estimate })}</span>
                                                    ) : null}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">{t("copyVideo.segmentDurationHint")}</p>
                                </div>
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
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("copyVideo.analysisHint")}</div>
                            <Button type="primary" shape="round" icon={<Sparkles className="size-4" />} onClick={analyze} loading={analyzing} disabled={!file}>
                                {t("copyVideo.analyze")}
                            </Button>
                        </div>
                        {analyzing ? (
                            <div className="flex flex-col gap-1.5">
                                <div className="flex items-center gap-3">
                                    <Progress percent={analysisPercent} showInfo={false} size="small" strokeColor="#78716c" className="!mb-0 flex-1" />
                                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-stone-500 dark:text-stone-400">{analysisPercent}%</span>
                                </div>
                                <div className="text-xs text-stone-500 dark:text-stone-400">
                                    {analysisStage === "frames" ? t("copyVideo.stageFrames") : null}
                                    {analysisStage === "transcribe" ? t("copyVideo.stageTranscribe") : null}
                                    {analysisStage === "overview" ? t("copyVideo.stageOverview") : null}
                                    {analysisStage === "window"
                                        ? t("copyVideo.stageWindow", { current: windowProgress?.current ?? 1, total: windowProgress?.total ?? 1 })
                                        : null}
                                </div>
                            </div>
                        ) : null}
                        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
                    </section>
                ) : (
                    <div className="flex flex-col gap-5">
                        {/* 一键替换品牌/产品 */}
                        <div ref={replaceBarRef}>
                            <CopyReplaceBar
                                analysis={analysis}
                                disabled={batchDisabled}
                                canUndo={Boolean(replaceUndo)}
                                inputRef={replaceInputRef}
                                onApply={applyTermReplace}
                                onUndo={undoTermReplace}
                            />
                        </div>

                        {/* 角色场景物品：统一生图参数 + 三块素材网格 + 风格 */}
                        <section className="overflow-hidden rounded-2xl border border-stone-200/70 bg-background dark:border-stone-800">
                            <div className="flex flex-col gap-3 border-b border-stone-200/70 bg-stone-50/70 px-4 py-3 xl:flex-row xl:items-center xl:justify-between dark:border-stone-800 dark:bg-stone-900/40">
                                <div className="flex shrink-0 items-center gap-3">
                                    <div className="flex size-9 items-center justify-center rounded-xl border border-stone-200/80 bg-background text-stone-500 dark:border-stone-700 dark:text-stone-300">
                                        <User className="size-4" />
                                    </div>
                                    <div>
                                        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{t("copyVideo.assetsTitle")}</h2>
                                        <p className="mt-0.5 text-[10px] text-stone-400 dark:text-stone-500">{t("copyVideo.assetsSubtitle")}</p>
                                    </div>
                                </div>
                                <CopyImageSettingsBar config={config} value={genSettings} onChange={patchSettings} disabled={batchDisabled}>
                                    <Button type="primary" shape="round" icon={<Sparkles className="size-3.5" />} loading={batchRunning === "asset-image"} disabled={batchDisabled} onClick={() => void runBatch("asset-image")}>
                                        {t("copyVideo.batchImage")}
                                    </Button>
                                </CopyImageSettingsBar>
                            </div>

                            <div className="space-y-4 p-4">
                                {/* 角色 */}
                                <div>
                                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                        <h3 className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                                            <User className="size-3" />
                                            {t("copyVideo.roles")}
                                            <span className="text-stone-300 dark:text-stone-600">({analysis.roles.length})</span>
                                        </h3>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <CharacterStyleSelect value={genSettings.characterStyle} onChange={(characterStyle) => patchSettings({ characterStyle })} disabled={batchDisabled} />
                                            <button
                                                type="button"
                                                onClick={() => openAddAsset("roles")}
                                                className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                                            >
                                                <Plus className="size-3" /> {t("copyVideo.add")}
                                            </button>
                                        </div>
                                    </div>
                                    <div className={gridClass}>
                                        {analysis.roles.map((item) => (
                                            <AssetCard
                                                key={item.id}
                                                item={item}
                                                kind="role"
                                                media={itemImages[item.id]}
                                                running={itemStatus[item.id] === "running"}
                                                failed={itemStatus[item.id] === "failed"}
                                                disabled={batchDisabled}
                                                onEdit={() => openEditAsset("roles", item)}
                                                onGenerate={() => void runItemImage(item, "roles")}
                                                onUpload={() => pickItemImage(item.id)}
                                                onRemove={() => removeItem("roles", item.id)}
                                                onPreview={() => itemImages[item.id]?.url && setPreviewUrl(itemImages[item.id].url)}
                                                onPickLibrary={() => setLibraryTarget(item.id)}
                                                aspectRatio={activeCharacterStyle.aspectRatio}
                                            />
                                        ))}
                                        {!analysis.roles.length ? <div className="col-span-full py-6 text-center text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.noRoles")}</div> : null}
                                    </div>
                                </div>

                                {/* 场景 + 物品：共用一行网格，标题各带数量 */}
                                <div>
                                    <div className="mb-2 flex items-center justify-between">
                                        <h3 className="flex items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
                                            <span className="flex items-center gap-1.5">
                                                <MapIcon className="size-3" />
                                                {t("copyVideo.scenes")}
                                                <span className="text-stone-300 dark:text-stone-600">({analysis.scenes.length})</span>
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <Package className="size-3" />
                                                {t("copyVideo.items")}
                                                <span className="text-stone-300 dark:text-stone-600">({analysis.items.length})</span>
                                            </span>
                                        </h3>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => openAddAsset("scenes")}
                                                className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                                            >
                                                <Plus className="size-3" /> {t("copyVideo.addScene")}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => openAddAsset("items")}
                                                className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-stone-500 transition-colors hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                                            >
                                                <Plus className="size-3" /> {t("copyVideo.addItem")}
                                            </button>
                                        </div>
                                    </div>
                                    <div className={gridClass}>
                                        {analysis.scenes.map((item) => (
                                            <AssetCard
                                                key={item.id}
                                                item={item}
                                                kind="scene"
                                                media={itemImages[item.id]}
                                                running={itemStatus[item.id] === "running"}
                                                failed={itemStatus[item.id] === "failed"}
                                                disabled={batchDisabled}
                                                onEdit={() => openEditAsset("scenes", item)}
                                                onGenerate={() => void runItemImage(item, "scenes")}
                                                onUpload={() => pickItemImage(item.id)}
                                                onRemove={() => removeItem("scenes", item.id)}
                                                onPreview={() => itemImages[item.id]?.url && setPreviewUrl(itemImages[item.id].url)}
                                                onPickLibrary={() => setLibraryTarget(item.id)}
                                            />
                                        ))}
                                        {analysis.items.map((item) => (
                                            <AssetCard
                                                key={item.id}
                                                item={item}
                                                kind="item"
                                                media={itemImages[item.id]}
                                                running={itemStatus[item.id] === "running"}
                                                failed={itemStatus[item.id] === "failed"}
                                                disabled={batchDisabled}
                                                onEdit={() => openEditAsset("items", item)}
                                                onGenerate={() => void runItemImage(item, "items")}
                                                onUpload={() => pickItemImage(item.id)}
                                                onRemove={() => removeItem("items", item.id)}
                                                onPreview={() => itemImages[item.id]?.url && setPreviewUrl(itemImages[item.id].url)}
                                                onPickLibrary={() => setLibraryTarget(item.id)}
                                            />
                                        ))}
                                        {!analysis.scenes.length && !analysis.items.length ? (
                                            <div className="col-span-full py-6 text-center text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.noScenesItems")}</div>
                                        ) : null}
                                    </div>
                                </div>

                                <div className="space-y-2 border-t border-stone-200/70 pt-3 dark:border-stone-800">
                                    <div className="flex items-center gap-2">
                                        <Palette className="size-3.5 text-stone-400" />
                                        <span className="text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.style")}:</span>
                                        {styleEditing ? (
                                            <div className="flex flex-1 items-center gap-2">
                                                <Input
                                                    size="small"
                                                    autoFocus
                                                    value={styleDraft}
                                                    onChange={(event) => setStyleDraft(event.target.value)}
                                                    onPressEnter={saveStyle}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Escape") setStyleEditing(false);
                                                    }}
                                                    placeholder={t("copyVideo.stylePlaceholder")}
                                                />
                                                <Button size="small" type="primary" icon={<Check className="size-3" />} onClick={saveStyle} />
                                                <Button size="small" icon={<X className="size-3" />} onClick={() => setStyleEditing(false)} />
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setStyleDraft(analysis.style || "");
                                                    setStyleEditing(true);
                                                }}
                                                className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-stone-600 transition-colors hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                                            >
                                                <span className="line-clamp-2 text-left">{analysis.style || t("copyVideo.styleUnset")}</span>
                                                <Pencil className="size-2.5 shrink-0 text-stone-300 transition-colors group-hover:text-stone-500 dark:text-stone-600" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Layers className="size-3.5 text-stone-400" />
                                        <span className="text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.spaceContext")}:</span>
                                        {spaceEditing ? (
                                            <div className="flex flex-1 items-center gap-2">
                                                <Input
                                                    size="small"
                                                    autoFocus
                                                    value={spaceDraft}
                                                    onChange={(event) => setSpaceDraft(event.target.value)}
                                                    onPressEnter={saveSpaceContext}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Escape") setSpaceEditing(false);
                                                    }}
                                                    placeholder={t("copyVideo.spaceContextPlaceholder")}
                                                />
                                                <Button size="small" type="primary" icon={<Check className="size-3" />} onClick={saveSpaceContext} />
                                                <Button size="small" icon={<X className="size-3" />} onClick={() => setSpaceEditing(false)} />
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSpaceDraft(analysis.spaceContext || "");
                                                    setSpaceEditing(true);
                                                }}
                                                className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-stone-600 transition-colors hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                                            >
                                                <span className="line-clamp-2 text-left">{analysis.spaceContext || t("copyVideo.spaceContextUnset")}</span>
                                                <Pencil className="size-2.5 shrink-0 text-stone-300 transition-colors group-hover:text-stone-500 dark:text-stone-600" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* 分镜列表 */}
                        <section className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
                            <div className="mb-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900 dark:text-stone-100">
                                        <Clapperboard className="size-4 text-stone-400" />
                                        {t("copyVideo.shots")}
                                        <span className="text-xs font-normal text-stone-400 dark:text-stone-500">{t("copyVideo.shotCount", { count: analysis.shots.length })}</span>
                                    </h2>
                                    <span className="rounded-full border border-stone-200 px-2 py-1 text-[10px] text-stone-500 dark:border-stone-700 dark:text-stone-400">
                                        {t("copyVideo.modeTag")}
                                    </span>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200/70 bg-stone-50/60 px-3 py-2 dark:border-stone-800 dark:bg-stone-900/40">
                                    <div className="flex h-9 items-center gap-1 rounded-lg border border-stone-200/70 bg-background py-1 pl-2.5 pr-1 dark:border-stone-700">
                                        <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">{t("copyVideo.ratio")}</span>
                                        <span className="mx-1 h-3.5 w-px bg-stone-200 dark:bg-stone-700" />
                                        {["16:9", "9:16", "1:1"].map((ratio) => (
                                            <button
                                                key={ratio}
                                                type="button"
                                                disabled={batchDisabled}
                                                aria-pressed={genSettings.videoRatio === ratio}
                                                onClick={() => patchSettings({ videoRatio: ratio })}
                                                className={[
                                                    "flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                                                    genSettings.videoRatio === ratio
                                                        ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                                                        : "text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                                                ].join(" ")}
                                            >
                                                {ratio}
                                            </button>
                                        ))}
                                    </div>
                                    <Button size="small" icon={<Wand2 className="size-3.5" />} disabled={batchDisabled} onClick={fillImagePrompts}>
                                        {t("copyVideo.genImagePrompts")}
                                    </Button>
                                    <Button size="small" icon={<Replace className="size-3.5" />} disabled={batchDisabled} onClick={focusReplaceBar}>
                                        {t("copyVideo.replaceShortcut")}
                                    </Button>
                                    <Button
                                        size="small"
                                        icon={<Sparkles className="size-3.5" />}
                                        loading={batchRunning === "shot-image"}
                                        disabled={batchDisabled}
                                        onClick={() => void runBatch("shot-image")}
                                    >
                                        {t("copyVideo.genShotImages")}
                                    </Button>
                                    <div className="ml-auto flex flex-wrap items-center gap-2">
                                        <CopyVideoSettingsBar config={config} value={genSettings} onChange={patchSettings} disabled={batchDisabled} />
                                        <Button size="small" icon={<Plus className="size-3.5" />} disabled={batchDisabled} onClick={addShot}>
                                            {t("copyVideo.add")}
                                        </Button>
                                        <Button type="primary" size="small" icon={<Sparkles className="size-3.5" />} loading={batchRunning === "shot-video"} disabled={batchDisabled} onClick={() => void runBatch("shot-video")}>
                                            {t("copyVideo.batchVideo")}
                                        </Button>
                                        <Button size="small" icon={<Download className="size-3.5" />} loading={batchRunning === "download"} disabled={batchDisabled} onClick={() => void downloadVideos()}>
                                            {t("copyVideo.batchDownload")}
                                        </Button>
                                    </div>
                                </div>
                            </div>

                            <ShotTable
                                shots={analysis.shots}
                                roles={analysis.roles}
                                scenes={analysis.scenes}
                                items={analysis.items}
                                itemImages={itemImages}
                                itemStatus={itemStatus}
                                imageRatio={genSettings.imageRatio}
                                disabled={batchDisabled}
                                storyboards={storyboards}
                                shotImages={shotImages}
                                shotVideos={shotVideos}
                                shotImageHistory={shotImageHistory}
                                shotVideoHistory={shotVideoHistory}
                                imageStatus={shotImageStatus}
                                videoStatus={shotStatus}
                                overrides={shotOverrides}
                                resolutionOptions={resolutionOptions}
                                secondsOptions={secondsOptions}
                                resolveVideoRefs={resolveShotVideoRefs}
                                getCopyPrompt={(shot) =>
                                    shotPrompt(shot, analysis.style || "", {
                                        roles: analysis.roles,
                                        spaceContext: analysis.spaceContext,
                                        referenceBindings: resolveShotVideoRefs(shot).bindings,
                                    })
                                }
                                onUpdate={updateShot}
                                onOverride={patchOverride}
                                onRemove={removeShot}
                                onMove={moveShot}
                                onEdit={setShotDraft}
                                onBindAsset={bindShotAsset}
                                onUnbindAsset={unbindShotAsset}
                                onGenerateAsset={(section, id) => {
                                    const target = analysis[section].find((item) => item.id === id);
                                    if (target) void runItemImage(target, section);
                                }}
                                onPickStoryboard={pickStoryboard}
                                onRemoveStoryboard={(id) => setStoryboards((prev) => {
                                    const next = { ...prev };
                                    delete next[id];
                                    return next;
                                })}
                                onGenerateImage={(shot) => void runShotImage(shot)}
                                onGenerateVideo={(shot) => void runShotVideo(shot)}
                                onOpenImageHistory={(id) => setMediaHistory({ kind: "image", shotId: id })}
                                onOpenVideoHistory={(id) => setMediaHistory({ kind: "video", shotId: id })}
                                onDownloadVideo={(shot) => void downloadShotVideo(shot)}
                                onPreviewImage={(url) => setPreviewUrl(url)}
                            />
                        </section>

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-400 dark:text-stone-500">
                            <span>{t("copyVideo.generateHint")}</span>
                            <span>{t("copyVideo.summary", { roles: analysis.roles.length, scenes: analysis.scenes.length, items: analysis.items.length, shots: analysis.shots.length })}</span>
                        </div>
                        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</div> : null}
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

            {/* 角色/场景/物品编辑 */}
            <Modal
                open={Boolean(assetDraft)}
                title={assetDraft?.id ? t("copyVideo.editAsset") : t("copyVideo.addAsset")}
                okText={t("copyVideo.save")}
                cancelText={t("common.cancel")}
                onOk={commitAsset}
                onCancel={() => setAssetDraft(null)}
                destroyOnHidden
            >
                {assetDraft ? (
                    <div className="space-y-3 pt-2">
                        <Input value={assetDraft.name} onChange={(event) => setAssetDraft({ ...assetDraft, name: event.target.value })} placeholder={t("copyVideo.namePlaceholder")} />
                        <Input.TextArea
                            value={assetDraft.description}
                            onChange={(event) => setAssetDraft({ ...assetDraft, description: event.target.value })}
                            rows={4}
                            placeholder={t("copyVideo.descPlaceholder")}
                        />
                        {assetDraft.section === "roles" ? (
                            <Input.TextArea
                                value={assetDraft.voice}
                                onChange={(event) => setAssetDraft({ ...assetDraft, voice: event.target.value })}
                                rows={2}
                                placeholder={t("copyVideo.voicePlaceholder")}
                            />
                        ) : null}
                    </div>
                ) : null}
            </Modal>

            {/* 分镜详情：景别/机位/表演/声音/台词/画面文字 */}
            <Modal
                open={Boolean(shotDraft)}
                title={t("copyVideo.shotDetail")}
                okText={t("copyVideo.save")}
                cancelText={t("common.cancel")}
                width={680}
                onOk={() => {
                    if (shotDraft) updateShot(shotDraft.id, shotDraft);
                    setShotDraft(null);
                }}
                onCancel={() => setShotDraft(null)}
                destroyOnHidden
            >
                {shotDraft ? (
                    <div className="grid gap-3 pt-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs text-stone-500 sm:col-span-2 dark:text-stone-400">
                            {t("copyVideo.videoPrompt")}
                            <Input.TextArea
                                rows={7}
                                value={shotDraft.videoPrompt || ""}
                                onChange={(event) => setShotDraft({ ...shotDraft, videoPrompt: event.target.value })}
                                placeholder={t("copyVideo.videoPromptPlaceholder")}
                            />
                        </label>
                        {(
                            [
                                ["start", t("copyVideo.fieldStart")],
                                ["end", t("copyVideo.fieldEnd")],
                                ["shotSize", t("copyVideo.fieldShotSize")],
                                ["cameraAngle", t("copyVideo.fieldCameraAngle")],
                                ["cameraMove", t("copyVideo.fieldCameraMove")],
                                ["duration", t("copyVideo.fieldDuration")],
                            ] as const
                        ).map(([key, label]) => (
                            <label key={key} className="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
                                {label}
                                <Input size="small" value={shotDraft[key]} onChange={(event) => setShotDraft({ ...shotDraft, [key]: event.target.value })} />
                            </label>
                        ))}
                        {(
                            [
                                ["performance", t("copyVideo.performancePlaceholder")],
                                ["sound", t("copyVideo.soundPlaceholder")],
                                ["dialogue", t("copyVideo.dialoguePlaceholder")],
                                ["onScreenText", t("copyVideo.onScreenTextPlaceholder")],
                            ] as const
                        ).map(([key, placeholder]) => (
                            <label key={key} className="flex flex-col gap-1 text-xs text-stone-500 sm:col-span-2 dark:text-stone-400">
                                <Input.TextArea rows={2} value={shotDraft[key]} onChange={(event) => setShotDraft({ ...shotDraft, [key]: event.target.value })} placeholder={placeholder} />
                            </label>
                        ))}
                    </div>
                ) : null}
            </Modal>

            {/* 分镜图片 / 视频的生成历史 */}
            <Modal
                open={Boolean(mediaHistory)}
                title={mediaHistory?.kind === "video" ? t("copyVideo.videoHistory") : t("copyVideo.imageHistory")}
                footer={null}
                width={720}
                onCancel={() => setMediaHistory(null)}
                destroyOnHidden
            >
                {mediaHistory ? (() => {
                    const list = (mediaHistory.kind === "image" ? shotImageHistory : shotVideoHistory)[mediaHistory.shotId] || [];
                    const current = (mediaHistory.kind === "image" ? shotImages : shotVideos)[mediaHistory.shotId];
                    const shotIndex = analysis?.shots.findIndex((shot) => shot.id === mediaHistory.shotId) ?? -1;
                    if (!list.length) return <div className="py-8 text-center text-xs text-stone-400">{t("copyVideo.historyEmptyMedia")}</div>;
                    return (
                        <div className="pt-2">
                            <div className="mb-3 text-xs text-stone-400 dark:text-stone-500">
                                {t("copyVideo.shot")} {String(shotIndex + 1).padStart(2, "0")} · {t("copyVideo.historyAvailable", { count: list.length })}
                            </div>
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                                {list.map((media) => {
                                    const active = Boolean(current?.storageKey) && current.storageKey === media.storageKey;
                                    return (
                                        <div key={media.storageKey} className={["overflow-hidden rounded-xl border", active ? "border-stone-400 dark:border-stone-500" : "border-stone-200 dark:border-stone-800"].join(" ")}>
                                            <div className="aspect-video bg-black">
                                                {mediaHistory.kind === "video" ? (
                                                    <video src={media.url} controls playsInline className="h-full w-full object-contain" />
                                                ) : (
                                                    <img src={media.url} alt="" className="h-full w-full cursor-zoom-in object-contain" onClick={() => setPreviewUrl(media.url)} />
                                                )}
                                            </div>
                                            <div className="p-2">
                                                <Button
                                                    size="small"
                                                    block
                                                    disabled={active}
                                                    icon={active ? <Check className="size-3.5" /> : undefined}
                                                    onClick={() => {
                                                        const apply = (prev: Record<string, CopyMedia>) => ({ ...prev, [mediaHistory.shotId]: media });
                                                        if (mediaHistory.kind === "image") setShotImages(apply);
                                                        else setShotVideos(apply);
                                                    }}
                                                >
                                                    {active ? t("copyVideo.currentInUse") : t("copyVideo.useResult")}
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })() : null}
            </Modal>
            {/* 看大图 */}
            <Modal open={Boolean(previewUrl)} footer={null} width={880} onCancel={() => setPreviewUrl("")} destroyOnHidden styles={{ body: { padding: 0 } }}>
                {previewUrl ? <img src={previewUrl} alt="" className="max-h-[80vh] w-full object-contain" /> : null}
            </Modal>

            {/* 从「我的素材」选一张图替换当前角色/场景/物品 */}
            <AssetPickerModal
                open={Boolean(libraryTarget)}
                defaultTab="image"
                onClose={() => setLibraryTarget(null)}
                onInsert={(payload: InsertAssetPayload) => {
                    const target = libraryTarget;
                    setLibraryTarget(null);
                    if (!target || payload.kind !== "image") return;
                    setItemImages((prev) => ({ ...prev, [target]: { url: payload.dataUrl, storageKey: payload.storageKey || "" } }));
                }}
            />
        </main>
    );
}
