import { Fragment } from "react";
import { Button, Input, Select } from "antd";
import { ChevronDown, ChevronUp, Copy, ImageIcon, ImagePlus, Info, Loader2, Sparkles, Trash2, Video } from "lucide-react";import { useTranslation } from "react-i18next";

import type { CopyShot } from "@/services/api/copy-video";
import type { CopyMedia } from "@/components/copy/types";
import type { ShotOverride } from "@/components/copy/copy-settings-panel";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";

type ShotTableProps = {
    shots: CopyShot[];
    imageRatio: string;
    disabled: boolean;
    storyboards: Record<string, CopyMedia>;
    shotImages: Record<string, CopyMedia>;
    shotVideos: Record<string, CopyMedia>;
    imageStatus: Record<string, string>;
    videoStatus: Record<string, string>;
    overrides: Record<string, ShotOverride>;
    resolutionOptions: { value: string; label: string }[];
    secondsOptions: { value: string; label: string }[];
    onUpdate: (id: string, patch: Partial<CopyShot>) => void;
    onOverride: (id: string, patch: ShotOverride) => void;
    onRemove: (id: string) => void;
    onMove: (id: string, delta: -1 | 1) => void;
    onEdit: (shot: CopyShot) => void;
    onPickStoryboard: (id: string) => void;
    onRemoveStoryboard: (id: string) => void;
    onGenerateImage: (shot: CopyShot) => void;
    onGenerateVideo: (shot: CopyShot) => void;
};

const cellClass = "border-b border-stone-200/70 px-1.5 py-3 align-middle dark:border-stone-800";
const ratioAspect = (ratio: string) => {
    const [w, h] = String(ratio || "16:9").split(":").map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 16 / 9;
};

/**
 * 分镜列表：每个分镜一行「信息条 + 内容行」。
 * 信息条放分镜号/时间/单镜分辨率时长；内容行是视频描述词、原视频分镜图、图片描述词、图片预览、视频预览。
 */
export function ShotTable(props: ShotTableProps) {
    const { shots, imageRatio, disabled, storyboards, shotImages, shotVideos, imageStatus, videoStatus, overrides, resolutionOptions, secondsOptions } = props;
    const { t } = useTranslation();
    const copyText = useCopyText();
    const aspect = { aspectRatio: String(ratioAspect(imageRatio)) };

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
                        const ratio = overrides[shot.id] || {};
                        return (
                            <Fragment key={shot.id}>
                                <tr>
                                    <td colSpan={5} className="rounded-t-xl border-x border-t border-stone-200/70 bg-stone-50/60 px-2 pb-0 pt-2 dark:border-stone-800 dark:bg-stone-900/40">
                                        <div className="flex min-w-[820px] flex-wrap items-center gap-3 border-b border-stone-200/60 px-2 pb-2 dark:border-stone-800">
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
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Select
                                                    size="small"
                                                    className="!w-[96px]"
                                                    value={ratio.resolution || undefined}
                                                    placeholder={t("copyVideo.resolutionDefault")}
                                                    disabled={disabled}
                                                    allowClear
                                                    options={resolutionOptions}
                                                    onChange={(value) => props.onOverride(shot.id, { resolution: value })}
                                                    popupMatchSelectWidth={false}
                                                />
                                                <Select
                                                    size="small"
                                                    className="!w-[96px]"
                                                    value={ratio.seconds || undefined}
                                                    placeholder={t("copyVideo.secondsDefault")}
                                                    disabled={disabled}
                                                    allowClear
                                                    options={secondsOptions}
                                                    onChange={(value) => props.onOverride(shot.id, { seconds: value })}
                                                    popupMatchSelectWidth={false}
                                                />
                                                <Button size="small" type="text" icon={<Info className="size-3.5" />} onClick={() => props.onEdit(shot)} title={t("copyVideo.shotDetail")} />
                                            </div>
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
                                        <div className="relative">
                                            <Input.TextArea
                                                value={shot.videoPrompt || ""}
                                                onChange={(event) => props.onUpdate(shot.id, { videoPrompt: event.target.value })}
                                                autoSize={{ minRows: 4, maxRows: 12 }}
                                                placeholder={t("copyVideo.videoPromptPlaceholder")}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => copyText(shot.videoPrompt || "")}
                                                className="absolute right-2 top-2 rounded bg-stone-100 p-1 text-stone-400 transition-colors hover:bg-stone-200 hover:text-stone-600 dark:bg-stone-800 dark:text-stone-500 dark:hover:bg-stone-700"
                                                title={t("copyVideo.copyPrompt")}
                                            >
                                                <Copy className="size-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                    <td className={cellClass}>
                                        <div
                                            className={cn(
                                                "relative mx-auto w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-900",
                                                storyboard?.url ? "cursor-pointer hover:border-stone-400 dark:hover:border-stone-500" : "",
                                            )}
                                            style={aspect}
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
                                            <div className="space-y-1.5">
                                                <div className="overflow-hidden rounded-lg border border-stone-200 bg-black dark:border-stone-700" style={aspect}>
                                                    <img src={image.url} alt={`shot-${index + 1}`} className="h-full w-full object-contain" />
                                                </div>
                                                <Button size="small" block icon={<Sparkles className="size-3.5" />} loading={imageRunning} disabled={disabled} onClick={() => props.onGenerateImage(shot)}>
                                                    {t("copyVideo.regenerate")}
                                                </Button>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => props.onGenerateImage(shot)}
                                                disabled={disabled || imageRunning}
                                                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-stone-400 hover:text-stone-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:text-stone-300"
                                                style={aspect}
                                            >
                                                {imageRunning ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
                                                <span className="text-[11px]">{imageRunning ? t("copyVideo.generating") : t("copyVideo.genShotImage")}</span>
                                            </button>
                                        )}
                                    </td>
                                    <td className={cellClass}>
                                        {video?.url ? (
                                            <div className="space-y-1.5">
                                                <video src={video.url} controls playsInline className="w-full rounded-lg bg-black" style={aspect} />
                                                <Button size="small" block icon={<Sparkles className="size-3.5" />} loading={videoRunning} disabled={disabled} onClick={() => props.onGenerateVideo(shot)}>
                                                    {t("copyVideo.regenerate")}
                                                </Button>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => props.onGenerateVideo(shot)}
                                                disabled={disabled || videoRunning}
                                                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-stone-400 hover:text-stone-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:text-stone-300"
                                                style={aspect}
                                            >
                                                {videoRunning ? <Loader2 className="size-4 animate-spin" /> : <Video className="size-4" />}
                                                <span className="text-[11px]">{videoRunning ? t("copyVideo.generating") : t("copyVideo.genShotVideo")}</span>
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
