import { useMemo, useState, type ReactNode } from "react";
import { Button, Popover, Select } from "antd";
import { Image as ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CHARACTER_STYLES, characterStyleOf, DEFAULT_CHARACTER_STYLE } from "@/config/character-styles";
import { clampSecondsToModel, videoModelCapability, videoModelDefaultResolution } from "@/config/video-models";
import { computeMediaSize, mediaRatioOptions, mediaScaleOptions } from "@/lib/media-size";
import { cn } from "@/lib/utils";
import { encodeChannelModel, modelOptionLabel, pickPreferredImageModelOption, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

/** 生成阶段的统一参数：所有角色/场景/物品共用一套生图参数，所有分镜共用一套生视频参数。 */
export type CopyGenSettings = {
    imageModel: string;
    imageRatio: string;
    imageScale: string;
    /** 角色样式：决定角色参考图的版式和提示词模板，见 config/character-styles */
    characterStyle: string;
    videoModel: string;
    videoRatio: string;
    videoResolution: string;
    videoSeconds: string;
};

/**
 * 默认生图模型优先用 GPT 系 image-2（tt-image-2）：按 size 精确出图且稳定性好。
 * 本地列表里没配置到，或旧配置还残留已下线的 gpt-image-2 时，一律用默认渠道编码的 tt-image-2。
 */
export function preferredImageModel(config: AiConfig) {
    const candidates = selectableModelsByCapability(config, "image");
    const matched = pickPreferredImageModelOption(candidates);
    if (matched) return matched;
    const current = (config.imageModel || "").trim();
    if (current && !/(^|::)gpt-image-2$/i.test(current)) return current;
    const channelId = config.channels[0]?.id || "default";
    return encodeChannelModel(channelId, "tt-image-2");
}

export function createCopyGenSettings(config: AiConfig): CopyGenSettings {
    return {
        imageModel: preferredImageModel(config),
        // 统一默认 16:9（业务口径）；需要竖屏时在面板里改。
        imageRatio: "16:9",
        imageScale: "1k",
        characterStyle: DEFAULT_CHARACTER_STYLE,
        videoModel: config.videoModel || "",
        videoRatio: "16:9",
        videoResolution: "720",
        // 默认按分镜自己的原片时长，复刻节奏最准；需要统一长度时在面板里改。
        videoSeconds: "auto",
    };
}

/** 分镜级覆盖：每个镜头可以在表格里单独选或批量改视频/生图模型和参数，留空则继承上方统一设置。 */
export type ShotOverride = {
    videoModel?: string;
    videoRatio?: string;
    resolution?: string;
    seconds?: string;
    imageModel?: string;
    imageRatio?: string;
    imageScale?: string;
};

const pill = "flex h-9 items-center gap-1 rounded-xl border border-stone-200/70 bg-stone-50/60 pl-2.5 pr-1 dark:border-stone-800 dark:bg-stone-900/40";
const pillLabel = "shrink-0 text-[11px] text-stone-400 dark:text-stone-500";
const divider = "mx-1 h-3.5 w-px bg-stone-200 dark:bg-stone-700";
// 参数栏里把 ModelPicker 自己的边框去掉，只保留外层胶囊
const pickerPlain = "!border-0 !bg-transparent !px-1 !shadow-none";

const ratioOptions = mediaRatioOptions.filter((item) => item.value !== "auto").map((item) => ({ value: item.value, label: item.value }));
const scaleOptions = mediaScaleOptions.filter((scale) => scale !== "auto").map((scale) => ({ value: scale, label: scale.toUpperCase() }));

export const copyImageRatioOptions = ratioOptions;
export const copyImageScaleOptions = scaleOptions;

export function videoModelResolutionOptions(model: string) {
    const capability = videoModelCapability(model);
    const tiers = capability?.resolutions?.length ? capability.resolutions : ["480", "720", "1080"];
    return tiers.map((tier) => ({ value: tier, label: `${tier}P` }));
}

export function videoModelRatioOptions(model: string) {
    const capability = videoModelCapability(model);
    const ratios = capability?.ratios?.length ? capability.ratios.filter((ratio) => ratio !== "auto") : [];
    return ratios.length ? ratios.map((ratio) => ({ value: ratio, label: ratio })) : ratioOptions;
}

export function videoModelSecondOptions(model: string, autoLabel: string, includeAuto = true) {
    const capability = videoModelCapability(model);
    const { min, max, step } = capability?.seconds ?? { min: 4, max: 30, step: 1 };
    const stride = step && step > 0 ? step : 1;
    const list: { value: string; label: string }[] = includeAuto ? [{ value: "auto", label: autoLabel }] : [];
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [...list, { value: "5", label: "5s" }];
    for (let seconds = min; seconds <= max; seconds += stride) list.push({ value: String(seconds), label: `${seconds}s` });
    return list;
}

export function cleanShotOverride(override?: ShotOverride): ShotOverride | undefined {
    if (!override) return undefined;
    const next: ShotOverride = {};
    const keys: (keyof ShotOverride)[] = ["videoModel", "videoRatio", "resolution", "seconds", "imageModel", "imageRatio", "imageScale"];
    for (const key of keys) {
        const raw = typeof override[key] === "string" ? override[key]!.trim() : "";
        if (raw) next[key] = raw;
    }
    return Object.keys(next).length ? next : undefined;
}

export function hasShotImageOverride(override?: ShotOverride) {
    return Boolean(cleanShotOverride({ imageModel: override?.imageModel, imageRatio: override?.imageRatio, imageScale: override?.imageScale }));
}

export function hasShotOverride(override?: ShotOverride) {
    return Boolean(cleanShotOverride(override));
}

export function normalizeVideoSettingsForModel(settings: CopyGenSettings, nextModel: string): Partial<CopyGenSettings> {
    const capability = videoModelCapability(nextModel);
    const patch: Partial<CopyGenSettings> = { videoModel: nextModel };
    if (!capability) return patch;
    if (capability.resolutions.length && !capability.resolutions.includes(settings.videoResolution)) {
        const forced = videoModelDefaultResolution(nextModel);
        patch.videoResolution = forced && capability.resolutions.includes(forced) ? forced : capability.resolutions[0];
    }
    if (capability.ratios.length && !capability.ratios.includes(settings.videoRatio)) {
        patch.videoRatio = capability.ratios[0];
    }
    if (settings.videoSeconds && settings.videoSeconds !== "auto") {
        patch.videoSeconds = clampSecondsToModel(nextModel, settings.videoSeconds);
    }
    return patch;
}

export function sanitizeShotOverrideForModel(override: ShotOverride | undefined, effectiveVideoModel: string): ShotOverride | undefined {
    const cleaned = cleanShotOverride(override);
    if (!cleaned) return undefined;
    const capability = videoModelCapability(effectiveVideoModel);
    if (!capability) return cleaned;
    const next: ShotOverride = { ...cleaned };
    if (next.resolution && capability.resolutions.length && !capability.resolutions.includes(next.resolution)) {
        delete next.resolution;
    }
    if (next.videoRatio && capability.ratios.length && !capability.ratios.includes(next.videoRatio)) {
        delete next.videoRatio;
    }
    if (next.seconds && next.seconds !== "auto") {
        const clamped = clampSecondsToModel(effectiveVideoModel, next.seconds);
        if (clamped) next.seconds = clamped;
    }
    return cleanShotOverride(next);
}

export function resolveShotDurationSeconds(
    shot: { duration?: string; start?: string; end?: string },
    effectiveVideoModel: string,
    settingSeconds: string,
): string {
    const capability = videoModelCapability(effectiveVideoModel);
    if (settingSeconds && settingSeconds !== "auto") {
        return clampSecondsToModel(effectiveVideoModel, settingSeconds);
    }
    const numeric = Number(String(shot.duration || "").replace(/[^0-9.]/g, ""));
    let seconds = Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
    if (!Number.isFinite(seconds)) {
        const timecode = (value?: string) => {
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
    const { min, max, step } = capability?.seconds ?? { min: 4, max: 30, step: 1 };
    if (!Number.isFinite(seconds)) {
        const fallback = capability?.defaultSeconds ?? 5;
        return String(Math.min(max, Math.max(min, fallback)));
    }
    const stride = step && step > 0 ? step : 1;
    const bounded = Math.min(max, Math.max(min, seconds));
    const snapped = min + Math.round((bounded - min) / stride) * stride;
    return String(Math.min(max, Math.max(min, snapped)));
}

export function resolveEffectiveShotVideoParams(
    shot: { duration?: string; start?: string; end?: string },
    settings: CopyGenSettings,
    override?: ShotOverride,
) {
    const videoModel = override?.videoModel || settings.videoModel;
    const capability = videoModelCapability(videoModel);
    const candidateRes = override?.resolution || settings.videoResolution;
    let videoResolution = candidateRes;
    if (capability?.resolutions?.length && !capability.resolutions.includes(candidateRes)) {
        const forced = videoModelDefaultResolution(videoModel);
        videoResolution = forced && capability.resolutions.includes(forced) ? forced : capability.resolutions[0];
    }
    const candidateRatio = override?.videoRatio || settings.videoRatio;
    let videoRatio = candidateRatio;
    if (capability?.ratios?.length && !capability.ratios.includes(candidateRatio)) {
        videoRatio = capability.ratios[0];
    }
    const videoSeconds = resolveShotDurationSeconds(shot, videoModel, override?.seconds || settings.videoSeconds);
    return { videoModel, videoRatio, videoResolution, videoSeconds };
}

export function resolveEffectiveShotImageParams(settings: CopyGenSettings, override?: ShotOverride) {
    const imageModel = override?.imageModel || settings.imageModel;
    const imageRatio = override?.imageRatio || settings.imageRatio;
    const imageScale = override?.imageScale || settings.imageScale;
    return { imageModel, imageRatio, imageScale, size: computeMediaSize(imageScale, imageRatio) };
}

type ImageBarProps = {
    config: AiConfig;
    value: CopyGenSettings;
    onChange: (patch: Partial<CopyGenSettings>) => void;
    disabled?: boolean;
    children?: ReactNode;
};

type CharacterStyleProps = {
    value: string;
    onChange: (styleId: string) => void;
    disabled?: boolean;
};

/** 角色样式选择器：仅作用于角色资产图，放在「角色」分栏标题旁，避免误以为会影响场景和物品。 */
export function CharacterStyleSelect({ value, onChange, disabled }: CharacterStyleProps) {
    const { t } = useTranslation();
    const active = characterStyleOf(value);
    const styleOptions = CHARACTER_STYLES.map((style) => ({
        value: style.id,
        label: (
            <div className="flex flex-col py-0.5">
                <span className="text-xs">{t(style.nameKey)}</span>
                <span className="text-[10px] opacity-60">
                    {style.aspectRatio} · {t(style.descriptionKey)}
                </span>
            </div>
        ),
    }));
    return (
        <div className={pill}>
            <span className={pillLabel}>{t("copyVideo.characterStyle")}</span>
            <span className={divider} />
            <Select
                variant="borderless"
                size="small"
                className="!w-[124px]"
                value={value}
                disabled={disabled}
                options={styleOptions}
                labelRender={() => <span className="text-xs">{t(active.nameKey)}</span>}
                onChange={onChange}
                popupMatchSelectWidth={false}
                styles={{ popup: { root: { minWidth: 260 } } }}
            />
        </div>
    );
}

/** 角色场景物品上方的一条紧凑参数栏：图片模型 / 比例 / 分辨率（+ 批量生图按钮）。 */
export function CopyImageSettingsBar({ config, value, onChange, disabled, children }: ImageBarProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.imageModel")}</span>
                <span className={divider} />
                <ModelPicker
                    config={config}
                    capability="image"
                    value={value.imageModel}
                    disabled={disabled}
                    onChange={(model) => onChange({ imageModel: model })}
                    placeholder={t("copyVideo.imageModel")}
                    className={cn(pickerPlain, disabled && "pointer-events-none opacity-60")}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.ratio")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[92px]"
                    value={value.imageRatio}
                    disabled={disabled}
                    options={ratioOptions}
                    onChange={(ratio) => onChange({ imageRatio: ratio })}
                    popupMatchSelectWidth={false}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.resolution")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[76px]"
                    value={value.imageScale}
                    disabled={disabled}
                    options={scaleOptions}
                    onChange={(scale) => onChange({ imageScale: scale })}
                    popupMatchSelectWidth={false}
                />
            </div>
            {children}
        </div>
    );
}

/** 分镜列表上方的一条参数栏：视频模型 / 画幅 / 分辨率 / 时长（+ 批量按钮）。 */
export function CopyVideoSettingsBar({ config, value, onChange, disabled, children }: ImageBarProps) {
    const { t } = useTranslation();

    const videoRatioChoices = useMemo(() => videoModelRatioOptions(value.videoModel), [value.videoModel]);
    const secondOptions = useMemo(() => videoModelSecondOptions(value.videoModel, t("copyVideo.secondsAuto"), true), [value.videoModel, t]);
    const resolutionOptions = useMemo(() => videoModelResolutionOptions(value.videoModel), [value.videoModel]);

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.videoModel")}</span>
                <span className={divider} />
                <ModelPicker
                    config={config}
                    capability="video"
                    value={value.videoModel}
                    disabled={disabled}
                    onChange={(model) => onChange({ videoModel: model })}
                    placeholder={t("copyVideo.videoModel")}
                    className={cn(pickerPlain, disabled && "pointer-events-none opacity-60")}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.ratio")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[92px]"
                    value={value.videoRatio}
                    disabled={disabled}
                    options={videoRatioChoices}
                    onChange={(ratio) => onChange({ videoRatio: ratio })}
                    popupMatchSelectWidth={false}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.resolution")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[76px]"
                    value={value.videoResolution}
                    disabled={disabled}
                    options={resolutionOptions}
                    onChange={(tier) => onChange({ videoResolution: tier })}
                    popupMatchSelectWidth={false}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.seconds")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[104px]"
                    value={value.videoSeconds}
                    disabled={disabled}
                    options={secondOptions}
                    onChange={(seconds) => onChange({ videoSeconds: seconds })}
                    popupMatchSelectWidth={false}
                />
            </div>
            {children}
        </div>
    );
}

type ShotImageParamsPopoverProps = {
    config: AiConfig;
    value: { imageModel?: string; imageRatio?: string; imageScale?: string };
    defaults?: { imageModel: string; imageRatio: string; imageScale: string };
    allowDefault?: boolean;
    title: string;
    triggerLabel: string;
    active?: boolean;
    disabled?: boolean;
    onChange: (patch: { imageModel?: string; imageRatio?: string; imageScale?: string }) => void;
    onReset?: () => void;
};

/** 分镜图参数弹出面板：用于单分镜独立调整、批量设置或默认分镜图参数设置。 */
export function ShotImageParamsPopover({
    config,
    value,
    defaults,
    allowDefault = true,
    title,
    triggerLabel,
    active = false,
    disabled = false,
    onChange,
    onReset,
}: ShotImageParamsPopoverProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    const defaultModelText = defaults?.imageModel
        ? `${t("copyVideo.imageModelDefault")} (${modelOptionLabel(config, defaults.imageModel)})`
        : t("copyVideo.imageModelDefault");

    return (
        <Popover
            trigger="click"
            placement="bottomRight"
            open={open}
            onOpenChange={(next) => {
                if (!next && pickerOpen) return;
                setOpen(next);
            }}
            content={
                <div className="w-[290px] space-y-2.5">
                    <div className="flex items-center justify-between gap-2 border-b border-stone-200/70 pb-1.5 dark:border-stone-700">
                        <span className="text-xs font-medium text-stone-800 dark:text-stone-100">{title}</span>
                        {onReset ? (
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={onReset}
                                className="cursor-pointer text-[11px] text-amber-600 transition-colors hover:text-amber-700 disabled:opacity-50 dark:text-amber-400"
                            >
                                {t("copyVideo.resetDefault")}
                            </button>
                        ) : null}
                    </div>
                    <div className="space-y-1">
                        <div className="text-[11px] text-stone-500 dark:text-stone-400">{t("copyVideo.imageModel")}</div>
                        <ModelPicker
                            config={config}
                            capability="image"
                            fullWidth
                            allowDefault={allowDefault}
                            defaultLabel={defaultModelText}
                            value={value.imageModel || ""}
                            disabled={disabled}
                            onMenuOpenChange={setPickerOpen}
                            onChange={(model) => onChange({ imageModel: model || undefined })}
                            className="!h-8 !rounded-lg !text-xs"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <div className="text-[11px] text-stone-500 dark:text-stone-400">{t("copyVideo.ratio")}</div>
                            <Select
                                size="small"
                                className="w-full"
                                allowClear={allowDefault}
                                placeholder={defaults?.imageRatio ? `${t("copyVideo.ratioDefault")} (${defaults.imageRatio})` : t("copyVideo.ratioDefault")}
                                value={value.imageRatio || undefined}
                                disabled={disabled}
                                options={copyImageRatioOptions}
                                getPopupContainer={(node) => node.parentElement || document.body}
                                onChange={(nextRatio) => onChange({ imageRatio: nextRatio || undefined })}
                            />
                        </div>
                        <div className="space-y-1">
                            <div className="text-[11px] text-stone-500 dark:text-stone-400">{t("copyVideo.resolution")}</div>
                            <Select
                                size="small"
                                className="w-full"
                                allowClear={allowDefault}
                                placeholder={
                                    defaults?.imageScale ? `${t("copyVideo.imageScaleDefault")} (${defaults.imageScale.toUpperCase()})` : t("copyVideo.imageScaleDefault")
                                }
                                value={value.imageScale || undefined}
                                disabled={disabled}
                                options={copyImageScaleOptions}
                                getPopupContainer={(node) => node.parentElement || document.body}
                                onChange={(nextScale) => onChange({ imageScale: nextScale || undefined })}
                            />
                        </div>
                    </div>
                </div>
            }
        >
            <Button
                size="small"
                disabled={disabled}
                className={cn(
                    "!inline-flex !items-center !gap-1",
                    active ? "!border-amber-500/70 !bg-amber-500/10 !text-amber-700 dark:!border-amber-400/60 dark:!text-amber-300" : "",
                )}
            >
                <ImageIcon className="size-3.5" />
                <span>{triggerLabel}</span>
                {active ? <span className="size-1.5 rounded-full bg-amber-500" /> : null}
            </Button>
        </Popover>
    );
}
