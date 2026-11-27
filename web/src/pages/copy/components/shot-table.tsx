import { Fragment, useMemo } from "react";
import { Button, Checkbox, Input, Select } from "antd";
import { ChevronDown, ChevronUp, Download, History, ImageIcon, ImagePlus, Info, Loader2, RotateCcw, Sparkles, Trash2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CopyAssetSection, CopyItem, CopyResolvedAsset, CopyShot, ShotReferenceBinding } from "@/services/api/copy-video";
import type { CopyMedia } from "@/components/copy/types";
import {
    hasShotImageOverride,
    hasShotOverride,
    ShotImageParamsPopover,
    videoModelRatioOptions,
    videoModelResolutionOptions,
    videoModelSecondOptions,
    type CopyGenSettings,
    type ShotOverride,
} from "@/components/copy/copy-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { ShotAssetBar, ShotPromptEditor } from "@/pages/copy/components/shot-prompt-editor";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type ShotTableProps = {
    config: AiConfig;
    genSettings: CopyGenSettings;
    shots: CopyShot[];
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    itemImages: Record<string, CopyMedia>;
    itemStatus: Record<string, string>;
    imageRatio: string;
    disabled: boolean;
    selectedIds: string[];
    storyboards: Record<string, CopyMedia>;
    shotImages: Record<string, CopyMedia>;
    shotVideos: Record<string, CopyMedia>;
    shotImageHistory: Record<string, CopyMedia[]>;
    shotVideoHistory: Record<string, CopyMedia[]>;
    imageStatus: Record<string, string>;
    videoStatus: Record<string, string>;
    overrides: Record<string, ShotOverride>;
    resolveVideoRefs: (shot: CopyShot) => { refs: ReferenceImage[]; bindings: ShotReferenceBinding[]; boundAssets: CopyResolvedAsset[] };
    getCopyPrompt?: (shot: CopyShot) => string;
    onToggleSelect: (id: string) => void;
    onUpdate: (id: string, patch: Partial<CopyShot>) => void;
    onOverride: (id: string, patch: ShotOverride) => void;
    onResetOverride: (id: string) => void;
    onRemove: (id: string) => void;
    onMove: (id: string, delta: -1 | 1) => void;
    onEdit: (shot: CopyShot) => void;
    onBindAsset: (shotId: string, section: CopyAssetSection, name: string) => void;
    onUnbindAsset: (shotId: string, section: CopyAssetSection, name: string) => void;
    onGenerateAsset: (section: CopyAssetSection, id: string) => void;
    onPickStoryboard: (id: string) => void;
    onRemoveStoryboard: (id: string) => void;
    onGenerateImage: (shot: CopyShot) => void;
    onGenerateVideo: (shot: CopyShot) => void;
    onOpenImageHistory: (id: string) => void;
    onOpenVideoHistory: (id: string) => void;
    onDownloadVideo: (shot: CopyShot) => void;
    /** 点图看大图 */
    onPreviewImage: (url: string) => void;
};

const cellClass = "border-b border-stone-200/70 px-1.5 py-3 align-middle dark:border-stone-800";
const ratioAspect = (ratio: string) => {
    const [w, h] = String(ratio || "16:9").split(":").map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 16 / 9;
};

/**
 * 分镜列表：每个分镜一行「信息条 + 内容行」。
 * 信息条放分镜勾选框/分镜号/时间/单镜视频模型、比例、分辨率、时长与生图参数；内容行是视频描述词、原视频分镜图、图片描述词、图片预览、视频预览。
 */
export function ShotTable(props: ShotTableProps) {
    const {
        config,
        genSettings,
        shots,
        roles,
        scenes,
        items,
        itemImages,
        itemStatus,
        imageRatio,
        disabled,
        selectedIds,
        storyboards,
        shotImages,
        shotVideos,
        shotImageHistory,
        shotVideoHistory,
        imageStatus,
        videoStatus,
        overrides,
    } = props;
    const { t } = useTranslation();
    const copyText = useCopyText();
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const allAssetsByName = useMemo(() => {
        const map = new Map<string, CopyResolvedAsset>();
        for (const item of roles) map.set(item.name, { id: item.id, name: item.name, description: item.description, kind: "role", section: "roles" });
        for (const item of scenes) map.set(item.name, { id: item.id, name: item.name, description: item.description, kind: "scene", section: "scenes" });
        for (const item of items) map.set(item.name, { id: item.id, name: item.name, description: item.description, kind: "item", section: "items" });
        return map;
    }, [roles, scenes, items]);

    return (
        <div className="w-full overflow-x-auto [scrollbar-width:thin]">
            <table className="w-full min-w-[1180px] table-fixed border-separate border-spacing-0 text-sm">
                <thead>
                    <tr className="border-b border-stone-200/70 text-[11px] font-normal text-stone-400 dark:border-stone-800 dark:text-stone-500">
                        <th className="w-[26%] px-1.5 py-2 text-left font-normal">{t("copyVideo.videoPrompt")}</th>
                        <th className="w-[16%] px-1.5 py-2 text-left font-normal">{t("copyVideo.storyboardImage")}</th>
                        <th className="w-[23%] px-1.5 py-2 text-left font-normal">{t("copyVideo.imagePrompt")}</th>
                        <th className="w-[18%] px-1.5 py-2 text-left font-normal">{t("copyVideo.imagePreview")}</th>
                        <th className="w-[17%] px-1.5 py-2 text-left font-normal">{t("copyVideo.videoPreview")}</th>
                    </tr>
                </thead>
                <tbody>
                    {shots.map((shot, index) => {
                        const storyboard = storyboards[shot.id];
                        const image = shotImages[shot.id];
                        const video = shotVideos[shot.id];
                        const imageRunning = imageStatus[shot.id] === "running";
                        const videoRunning = videoStatus[shot.id] === "running";
                        const override = overrides[shot.id] || {};
                        const effectiveVideoModel = override.videoModel || genSettings.videoModel;
                        const shotRatioOptions = videoModelRatioOptions(effectiveVideoModel);
                        const shotResolutionOptions = videoModelResolutionOptions(effectiveVideoModel);
                        const shotSecondsOptions = videoModelSecondOptions(effectiveVideoModel, t("copyVideo.secondsAuto"), true);
                        const isSelected = selectedSet.has(shot.id);
                        const isCustomized = hasShotOverride(override);
                        const hasImgCustom = hasShotImageOverride(override);
                        const imageAspect = { aspectRatio: String(ratioAspect(override.imageRatio || imageRatio)) };
                        const videoAspect = { aspectRatio: String(ratioAspect(override.videoRatio || genSettings.videoRatio || imageRatio)) };
                        const resolvedRefs = props.resolveVideoRefs(shot);
                        return (
                            <Fragment key={shot.id}>
                                <tr>
                                    <td
                                        colSpan={5}
                                        className={cn(
                                            "rounded-t-xl border-x border-t px-2 pb-0 pt-2 transition-colors",
                                            isSelected
                                                ? "border-amber-400/70 bg-amber-50/40 dark:border-amber-500/40 dark:bg-amber-950/20"
                                                : "border-stone-200/70 bg-stone-50/60 dark:border-stone-800 dark:bg-stone-900/40",
                                        )}
                                    >
                                        <div className="flex min-w-[820px] flex-wrap items-center gap-2.5 border-b border-stone-200/60 px-2 pb-2 dark:border-stone-800">
                                            <Checkbox
                                                checked={isSelected}
                                                disabled={disabled}
                                                onChange={() => props.onToggleSelect(shot.id)}
                                                aria-label={`${t("copyVideo.shot")} ${String(index + 1).padStart(2, "0")}`}
                                            />
                                            <div className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-stone-200/80 bg-background px-2.5 dark:border-stone-700">
                                                <span className="rounded-md bg-stone-900 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white dark:bg-stone-100 dark:text-stone-900">
                                                    {t("copyVideo.shot")} {String(index + 1).padStart(2, "0")}
                                                </span>
                                                <span className="text-xs text-stone-500 dark:text-stone-400">
                                                    {shot.start || "--"}
                                                    <span className="mx-1 text-stone-300 dark:text-stone-600">→</span>
                                                    {shot.end || "--"}
                                                </span>
                                                {shot.duration ? <span className="text-[11px] text-stone-400 dark:text-stone-500">{shot.duration}</span> : null}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <ModelPicker
                                                    config={config}
                                                    capability="video"
                                                    allowDefault
                                                    defaultLabel={t("copyVideo.videoModelDefault")}
                                                    value={override.videoModel || ""}
                                                    disabled={disabled}
                                                    onChange={(model) => props.onOverride(shot.id, { videoModel: model || undefined })}
                                                    className={cn(
                                                        "!h-7 !min-w-[136px] !max-w-[200px] !rounded-md !px-2 !text-xs",
                                                        override.videoModel
                                                            ? "!border-amber-500/60 !bg-amber-50/60 text-stone-900 dark:!border-amber-400/50 dark:!bg-amber-950/30 dark:text-stone-100"
                                                            : "!border-stone-200/90 !bg-background text-stone-500 dark:!border-stone-700 dark:text-stone-400",
                                                    )}
                                                />
                                                <Select
                                                    size="small"
                                                    className="!w-[84px]"
                                                    value={override.videoRatio || undefined}
                                                    placeholder={t("copyVideo.ratioDefault")}
                                                    disabled={disabled}
                                                    allowClear
                                                    options={shotRatioOptions}
                                                    onChange={(value) => props.onOverride(shot.id, { videoRatio: value || undefined })}
                                                    popupMatchSelectWidth={false}
                                                />
                                                <Select
                                                    size="small"
                                                    className="!w-[92px]"
                                                    value={override.resolution || undefined}
                                                    placeholder={t("copyVideo.resolutionDefault")}
                                                    disabled={disabled}
                                                    allowClear
                                                    options={shotResolutionOptions}
                                                    onChange={(value) => props.onOverride(shot.id, { resolution: value || undefined })}
                                                    popupMatchSelectWidth={false}
                                                />
                                                <Select
                                                    size="small"
                                                    className="!w-[96px]"
                                                    value={override.seconds || undefined}
                                                    placeholder={t("copyVideo.secondsDefault")}
                                                    disabled={disabled}
                                                    allowClear
                                                    options={shotSecondsOptions}
                                                    onChange={(value) => props.onOverride(shot.id, { seconds: value || undefined })}
                                                    popupMatchSelectWidth={false}
                                                />
                                                <ShotImageParamsPopover
                                                    config={config}
                                                    allowDefault
                                                    value={{ imageModel: override.imageModel, imageRatio: override.imageRatio, imageScale: override.imageScale }}
                                                    defaults={{ imageModel: genSettings.imageModel, imageRatio: genSettings.imageRatio, imageScale: genSettings.imageScale }}
                                                    title={t("copyVideo.shotImageParamsTitle")}
                                                    triggerLabel={t("copyVideo.shotImageParams")}
                                                    active={hasImgCustom}
                                                    disabled={disabled}
                                                    onChange={(patch) => props.onOverride(shot.id, patch)}
                                                    onReset={
                                                        hasImgCustom
                                                            ? () => props.onOverride(shot.id, { imageModel: undefined, imageRatio: undefined, imageScale: undefined })
                                                            : undefined
                                                    }
                                                />
                                                {isCustomized ? (
                                                    <Button
                                                        size="small"
                                                        type="text"
                                                        icon={<RotateCcw className="size-3" />}
                                                        disabled={disabled}
                                                        onClick={() => props.onResetOverride(shot.id)}
                                                        title={t("copyVideo.resetShotOverride")}
                                                    />
                                                ) : null}
                                                <Button size="small" type="text" icon={<Info className="size-3.5" />} onClick={() => props.onEdit(shot)} title={t("copyVideo.shotDetail")} />
                                            </div>
                                            <ShotAssetBar
                                                boundAssets={resolvedRefs.boundAssets}
                                                roles={roles}
                                                scenes={scenes}
                                                items={items}
                                                itemImages={itemImages}
                                                itemStatus={itemStatus}
                                                refs={resolvedRefs.refs}
                                                bindings={resolvedRefs.bindings}
                                                disabled={disabled}
                                                onBindAsset={(section, name) => props.onBindAsset(shot.id, section, name)}
                                                onUnbindAsset={(section, name) => props.onUnbindAsset(shot.id, section, name)}
                                                onGenerateAsset={props.onGenerateAsset}
                                                onPreviewImage={props.onPreviewImage}
                                            />
                                            <div className="ml-auto flex items-center gap-0.5">
                                                <Button size="small" type="text" icon={<ChevronUp className="size-3.5" />} disabled={index === 0} onClick={() => props.onMove(shot.id, -1)} />
                                                <Button size="small" type="text" icon={<ChevronDown className="size-3.5" />} disabled={index === shots.length - 1} onClick={() => props.onMove(shot.id, 1)} />
                                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => props.onRemove(shot.id)} title={t("copyVideo.deleteShot")} />
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                                <tr className="align-middle transition-colors [&>td]:border-b [&>td]:border-stone-200/70 [&>td]:bg-stone-50/60 hover:[&>td]:bg-stone-100/60 dark:[&>td]:border-stone-800 dark:[&>td]:bg-stone-900/40 dark:hover:[&>td]:bg-stone-900/70 [&>td:first-child]:border-l [&>td:first-child]:rounded-bl-xl [&>td:last-child]:border-r [&>td:last-child]:rounded-br-xl">
                                    <td className={cellClass}>
                                        <ShotPromptEditor
                                            value={shot.videoPrompt || ""}
                                            placeholder={t("copyVideo.videoPromptPlaceholder")}
                                            assets={resolvedRefs.boundAssets}
                                            allAssetsByName={allAssetsByName}
                                            itemImages={itemImages}
                                            itemStatus={itemStatus}
                                            bindings={resolvedRefs.bindings}
                                            copyTitle={t("copyVideo.copyPrompt")}
                                            onChange={(next) => props.onUpdate(shot.id, { videoPrompt: next })}
                                            onCopy={() => copyText(props.getCopyPrompt ? props.getCopyPrompt(shot) : shot.videoPrompt || "")}
                                            onPreviewImage={props.onPreviewImage}
                                            onGenerateAsset={props.onGenerateAsset}
                                        />
                                    </td>
                                    <td className={cellClass}>
                                        <div
                                            className={cn(
                                                "relative mx-auto w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-900",
                                                storyboard?.url ? "cursor-pointer hover:border-stone-400 dark:hover:border-stone-500" : "",
                                            )}
                                            style={imageAspect}
                                        >
                                            {storyboard?.url ? (
                                                <img src={storyboard.url} alt={`storyboard-${index + 1}`} className="h-full w-full object-contain" />
                                            ) : (
                                                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-stone-300 dark:text-stone-700">
                                                    <ImageIcon className="size-5" />
                                                    <span className="text-[10px]">{t("copyVideo.noImage")}</span>
                                                </div>
                                            )}
                                            <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        props.onPickStoryboard(shot.id);
                                                    }}
                                                    className="flex size-6 items-center justify-center rounded-md border border-stone-200 bg-white/85 text-stone-500 shadow-sm backdrop-blur transition-colors hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800/85 dark:text-stone-300 dark:hover:text-white"
                                                    title={storyboard?.url ? t("copyVideo.replaceStoryboard") : t("copyVideo.uploadStoryboard")}
                                                >
                                                    <ImagePlus className="size-3" />
                                                </button>
                                                {storyboard?.url ? (
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            props.onRemoveStoryboard(shot.id);
                                                        }}
                                                        className="flex size-6 items-center justify-center rounded-md border border-stone-200 bg-white/85 text-stone-400 shadow-sm backdrop-blur transition-colors hover:text-rose-500 dark:border-stone-700 dark:bg-stone-800/85"
                                                        title={t("copyVideo.removeStoryboard")}
                                                    >
                                                        <Trash2 className="size-3" />
                                                    </button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </td>
                                    <td className={cellClass}>
                                        <Input.TextArea
                                            value={shot.imagePrompt || ""}
                                            onChange={(event) => props.onUpdate(shot.id, { imagePrompt: event.target.value })}
                                            autoSize={{ minRows: 4, maxRows: 12 }}
                                            placeholder={t("copyVideo.imagePromptPlaceholder")}
                                        />
                                    </td>
                                    <td className={cellClass}>
                                        {image?.url ? (
                                            <div className="relative space-y-1.5">
                                                {imageRunning ? (
                                                    <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/45">
                                                        <Loader2 className="size-5 animate-spin" style={{ color: "#fff" }} />
                                                    </span>
                                                ) : null}
                                                <div className="cursor-zoom-in overflow-hidden rounded-lg border border-stone-200 bg-black dark:border-stone-700" style={imageAspect} onClick={() => props.onPreviewImage(image.url)}>
                                                    <img src={image.url} alt={`shot-${index + 1}`} className="h-full w-full object-contain" />
                                                </div>
                                                <div className="flex gap-1.5">
                                                    <Button size="small" className="flex-1" icon={<Sparkles className="size-3.5" />} loading={imageRunning} disabled={disabled} onClick={() => props.onGenerateImage(shot)}>
                                                        {t("copyVideo.regenerate")}
                                                    </Button>
                                                    <Button size="small" icon={<History className="size-3.5" />} onClick={() => props.onOpenImageHistory(shot.id)}>
                                                        {(shotImageHistory[shot.id] || []).length || ""}
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => props.onGenerateImage(shot)}
                                                disabled={disabled || imageRunning}
                                                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-stone-400 hover:text-stone-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:text-stone-300"
                                                style={imageAspect}
                                            >
                                                {imageRunning ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
                                                <span className="text-[11px]">{imageRunning ? t("copyVideo.generating") : t("copyVideo.genShotImage")}</span>
                                            </button>
                                        )}
                                    </td>
                                    <td className={cellClass}>
                                        {video?.url ? (
                                            <div className="space-y-1.5">
                                                <video src={video.url} controls playsInline className="w-full rounded-lg bg-black" style={videoAspect} />
                                                <div className="flex gap-1.5">
                                                    <Button size="small" className="flex-1" icon={<Sparkles className="size-3.5" />} loading={videoRunning} disabled={disabled} onClick={() => props.onGenerateVideo(shot)}>
                                                        {t("copyVideo.regenerate")}
                                                    </Button>
                                                    <Button size="small" icon={<History className="size-3.5" />} onClick={() => props.onOpenVideoHistory(shot.id)}>
                                                        {(shotVideoHistory[shot.id] || []).length || ""}
                                                    </Button>
                                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => props.onDownloadVideo(shot)} title={t("copyVideo.download")} />
                                                </div>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => props.onGenerateVideo(shot)}
                                                disabled={disabled || videoRunning}
                                                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-stone-400 hover:text-stone-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:text-stone-300"
                                                style={videoAspect}
                                            >
                                                {videoRunning ? <Loader2 className="size-4 animate-spin" /> : <Video className="size-4" />}
                                                <span className="text-[11px]">{videoRunning ? t("copyVideo.etaLong") : t("copyVideo.genShotVideo")}</span>
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
            {!shots.length ? <div className="py-8 text-center text-xs text-stone-400 dark:text-stone-500">{t("copyVideo.noShots")}</div> : null}
        </div>
    );
}
