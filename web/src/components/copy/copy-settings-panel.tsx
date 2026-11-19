import { useMemo } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { videoModelCapability } from "@/config/video-models";
import { mediaRatioOptions, mediaScaleOptions } from "@/lib/media-size";
import type { AiConfig } from "@/stores/use-config-store";

/** 生成阶段的统一参数：所有角色/场景/物品共用一套生图参数，所有分镜共用一套生视频参数。 */
export type CopyGenSettings = {
    imageModel: string;
    imageRatio: string;
    imageScale: string;
    videoModel: string;
    videoRatio: string;
    videoResolution: string;
    videoSeconds: string;
};

export function createCopyGenSettings(config: AiConfig): CopyGenSettings {
    return {
        imageModel: config.imageModel || "",
        // 爆款复刻基本是竖屏，默认 9:16；分析出片子的真实比例后会被覆盖。
        imageRatio: "9:16",
        imageScale: "1k",
        videoModel: config.videoModel || "",
        videoRatio: "9:16",
        videoResolution: "720",
        // 默认按分镜自己的原片时长，复刻节奏最准；需要统一长度时在面板里改。
        videoSeconds: "auto",
    };
}

type CopySettingsPanelProps = {
    config: AiConfig;
    value: CopyGenSettings;
    onChange: (patch: Partial<CopyGenSettings>) => void;
    disabled?: boolean;
};

export function CopySettingsPanel({ config, value, onChange, disabled }: CopySettingsPanelProps) {
    const { t } = useTranslation();
    const capability = videoModelCapability(value.videoModel);

    // 时长候选按模型能力生成：写死时长的模型（min === max）只出现一个选项。
    // 首项「按分镜时长」= 每个分镜用自己的原片时长（复刻节奏），其余是统一时长。
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

    const ratioOptions = useMemo(
        () => mediaRatioOptions.filter((item) => item.value !== "auto").map((item) => ({ value: item.value, label: item.value })),
        [],
    );

    const groupClass = "flex flex-wrap items-center gap-x-3 gap-y-2";
    const labelClass = "text-xs font-medium text-stone-500 dark:text-stone-400";
    const selectClass = "!w-28";

    return (
        <section className="rounded-2xl border border-stone-200/70 bg-background p-4 dark:border-stone-800">
            <div className="mb-3 text-sm font-semibold text-stone-800 dark:text-stone-200">{t("copyVideo.settings")}</div>
            <div className="flex flex-col gap-4">
                <div className={groupClass}>
                    <span className={`${labelClass} w-10`}>{t("copyVideo.imageGroup")}</span>
                    <ModelPicker
                        config={config}
                        capability="image"
                        value={value.imageModel}
                        onChange={(model) => onChange({ imageModel: model })}
                        placeholder={t("copyVideo.imageModel")}
                        className={disabled ? "pointer-events-none opacity-60" : undefined}
                    />
                    <span className={labelClass}>{t("copyVideo.ratio")}</span>
                    <Select
                        size="small"
                        className={selectClass}
                        value={value.imageRatio}
                        disabled={disabled}
                        options={ratioOptions}
                        onChange={(ratio) => onChange({ imageRatio: ratio })}
                        popupMatchSelectWidth={false}
                    />
                    <span className={labelClass}>{t("copyVideo.resolution")}</span>
                    <Select
                        size="small"
                        className={selectClass}
                        value={value.imageScale}
                        disabled={disabled}
                        options={mediaScaleOptions.filter((scale) => scale !== "auto").map((scale) => ({ value: scale, label: scale.toUpperCase() }))}
                        onChange={(scale) => onChange({ imageScale: scale })}
                        popupMatchSelectWidth={false}
                    />
                </div>

                <div className={groupClass}>
                    <span className={`${labelClass} w-10`}>{t("copyVideo.videoGroup")}</span>
                    <ModelPicker
                        config={config}
                        capability="video"
                        value={value.videoModel}
                        onChange={(model) => onChange({ videoModel: model })}
                        placeholder={t("copyVideo.videoModel")}
                        className={disabled ? "pointer-events-none opacity-60" : undefined}
                    />
                    <span className={labelClass}>{t("copyVideo.ratio")}</span>
                    <Select
                        size="small"
                        className={selectClass}
                        value={value.videoRatio}
                        disabled={disabled}
                        options={ratioOptions}
                        onChange={(ratio) => onChange({ videoRatio: ratio })}
                        popupMatchSelectWidth={false}
                    />
                    <span className={labelClass}>{t("copyVideo.resolution")}</span>
                    <Select
                        size="small"
                        className={selectClass}
                        value={value.videoResolution}
                        disabled={disabled}
                        options={resolutionOptions}
                        onChange={(tier) => onChange({ videoResolution: tier })}
                        popupMatchSelectWidth={false}
                    />
                    <span className={labelClass}>{t("copyVideo.seconds")}</span>
                    <Select
                        size="small"
                        className={selectClass}
                        value={value.videoSeconds}
                        disabled={disabled}
                        options={secondOptions}
                        onChange={(seconds) => onChange({ videoSeconds: seconds })}
                        popupMatchSelectWidth={false}
                    />
                </div>
            </div>
            <div className="mt-3 text-[11px] leading-5 text-stone-400 dark:text-stone-500">{t("copyVideo.settingsHint")}</div>
        </section>
    );
}
