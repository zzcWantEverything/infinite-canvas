import { useMemo, type ReactNode } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CHARACTER_STYLES, characterStyleOf, DEFAULT_CHARACTER_STYLE } from "@/config/character-styles";
import { videoModelCapability } from "@/config/video-models";
import { mediaRatioOptions, mediaScaleOptions } from "@/lib/media-size";
import { cn } from "@/lib/utils";
import type { AiConfig } from "@/stores/use-config-store";

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

export function createCopyGenSettings(config: AiConfig): CopyGenSettings {
    return {
        imageModel: config.imageModel || "",
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

/** 分镜级覆盖：每个镜头可以在表格里单独改分辨率和时长，模型仍走上方统一选择。 */
export type ShotOverride = { resolution?: string; seconds?: string };

const pill = "flex h-9 items-center gap-1 rounded-xl border border-stone-200/70 bg-stone-50/60 pl-2.5 pr-1 dark:border-stone-800 dark:bg-stone-900/40";
const pillLabel = "shrink-0 text-[11px] text-stone-400 dark:text-stone-500";
const divider = "mx-1 h-3.5 w-px bg-stone-200 dark:bg-stone-700";
// 参数栏里把 ModelPicker 自己的边框去掉，只保留外层胶囊
const pickerPlain = "!border-0 !bg-transparent !px-1 !shadow-none";

const ratioOptions = mediaRatioOptions.filter((item) => item.value !== "auto").map((item) => ({ value: item.value, label: item.value }));
const scaleOptions = mediaScaleOptions.filter((scale) => scale !== "auto").map((scale) => ({ value: scale, label: scale.toUpperCase() }));

type ImageBarProps = {
    config: AiConfig;
    value: CopyGenSettings;
    onChange: (patch: Partial<CopyGenSettings>) => void;
    disabled?: boolean;
    children?: ReactNode;
};

/** 角色场景物品上方的一条紧凑参数栏：角色样式 / 图片模型 / 比例 / 分辨率（+ 批量生图按钮）。 */
export function CopyImageSettingsBar({ config, value, onChange, disabled, children }: ImageBarProps) {
    const { t } = useTranslation();
    const active = characterStyleOf(value.characterStyle);
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
        <div className="flex flex-wrap items-center gap-2">
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.characterStyle")}</span>
                <span className={divider} />
                <Select
                    variant="borderless"
                    size="small"
                    className="!w-[124px]"
                    value={value.characterStyle}
                    disabled={disabled}
                    options={styleOptions}
                    labelRender={() => <span className="text-xs">{t(active.nameKey)}</span>}
                    onChange={(id) => onChange({ characterStyle: id })}
                    popupMatchSelectWidth={false}
                    styles={{ popup: { root: { minWidth: 260 } } }}
                />
            </div>
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.imageModel")}</span>
                <span className={divider} />
                <ModelPicker
                    config={config}
                    capability="image"
                    value={value.imageModel}
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
    const capability = videoModelCapability(value.videoModel);

    const secondOptions = useMemo(() => {
        const { min, max, step } = capability?.seconds ?? { min: 5, max: 10, step: 1 };
        const stride = step && step > 0 ? step : 1;
        const list: { value: string; label: string }[] = [{ value: "auto", label: t("copyVideo.secondsAuto") }];
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [...list, { value: "5", label: "5s" }];
        for (let seconds = min; seconds <= max; seconds += stride) list.push({ value: String(seconds), label: `${seconds}s` });
        return list;
    }, [capability, t]);

    const resolutionOptions = useMemo(() => {
        const tiers = capability?.resolutions?.length ? capability.resolutions : ["480", "720", "1080"];
        return tiers.map((tier) => ({ value: tier, label: `${tier}P` }));
    }, [capability]);

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className={pill}>
                <span className={pillLabel}>{t("copyVideo.videoModel")}</span>
                <span className={divider} />
                <ModelPicker
                    config={config}
                    capability="video"
                    value={value.videoModel}
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
                    options={ratioOptions}
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
