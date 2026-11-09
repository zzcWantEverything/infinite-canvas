import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Slider } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { estimateVideoPrice, videoModelCapability, videoModelPrice, type VideoModelCapability } from "@/config/video-models";
import { reportApiError } from "@/services/api/http";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { fetchGroupRatio, type PricingRatioSnapshot } from "@/services/api/pricing";
import { modelCatalogVersion, subscribeModelCatalog } from "@/services/api/model-catalog";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    // 能力优先取网关目录，目录拉到之前先用内置表兜底；目录是异步来的，订阅版本号让面板重算一次。
    const catalogVersion = useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
    const modelName = modelOptionName(config.videoModel || config.model);
    const capability = useMemo(() => videoModelCapability(modelName), [modelName, catalogVersion]);
    // 火山格式的模型各自限制尺寸、时长和参考素材，面板按当前模型的能力渲染；其他模型沿用全局范围。
    const secondsRange = capability ? { min: capability.seconds.min, max: capability.seconds.max, step: capability.seconds.step || 1 } : { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX, step: 1 };
    const seconds = capability ? clampRangeSeconds(capability, config.videoSeconds) : Number(clampVideoSeconds(config.videoSeconds || "6"));
    // 时长写死的模型（min === max）没有可拖动区间，antd 的 (value-min)/(max-min) 会算出 NaN，
    // 缩略点被钉在起点。这里改用「全局秒数轴」，让 10 秒这类固定时长落在它该在的位置，同时禁用拖动。
    const fixedSeconds = Boolean(capability && capability.seconds.min === capability.seconds.max);
    const secondsAxis = fixedSeconds ? { min: VIDEO_SECONDS_MIN, max: Math.max(VIDEO_SECONDS_MAX, seconds), step: 1 } : secondsRange;
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const resolution = parseVideoResolution(config.vquality);
    const secondsNote = buildSecondsNote(capability, seconds, resolution, fixedSeconds);
    const selectedRatio = inferVideoRatio(config.size || "auto");
    const dimensions = readVideoDimensions(config.size || "auto", resolution, selectedRatio);
    const supportedRatios = capability ? videoRatioOptions.filter((item) => capability.ratios.includes(item.value)) : videoRatioOptions;
    const supportedResolutions = capability ? resolutionOptions.filter((item) => capability.resolutions.includes(item.value)) : resolutionOptions;
    // 目录只带能力不带金额时不能估出 0 元，宁可显示「-」。
    const basePrice = capability && !capability.priceUnknown ? estimateVideoPrice(capability, { seconds, resolution, hasReferenceVideo: false }) : null;

    // 从 /api/pricing 拉取当前用户的分组倍数，乘入预估价格使其与后端预扣费一致。
    // 取数逻辑放在 services/api/pricing，不把 apiKey 当硬前置条件——否则面板拿不到 key 时倍率会静默变成 1。
    const [ratioSnapshot, setRatioSnapshot] = useState<PricingRatioSnapshot | null>(null);
    useEffect(() => {
        if (!capability) return;
        let alive = true;
        fetchGroupRatio(config.baseUrl, config.apiKey)
            .then((snapshot) => {
                if (alive) setRatioSnapshot(snapshot);
            })
            .catch(reportApiError);
        return () => {
            alive = false;
        };
    }, [capability, config.baseUrl, config.apiKey]);

    const groupRatio = ratioSnapshot?.ratio ?? 1;
    const price = basePrice !== null ? basePrice * groupRatio : null;
    const priceHint = ratioSnapshot ? t("settingsPanels.video.groupRatio", { group: ratioSnapshot.group, ratio: formatRatio(groupRatio) }) : "";
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {supportedResolutions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        {capability ? null : <ResolutionInput value={resolution} theme={theme} onChange={selectResolution} />}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {supportedRatios.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-[88px] flex-1" min={secondsAxis.min} max={secondsAxis.max} step={secondsAxis.step} value={seconds} disabled={fixedSeconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput value={seconds} min={secondsRange.min} max={secondsRange.max} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                        {secondsNote ? <span className="ml-auto shrink-0 whitespace-nowrap text-[11px]" style={{ color: theme.node.muted }}>{secondsNote}</span> : null}
                    </div>
                </SettingGroup>
                {capability ? (
                    <SettingGroup title={t("settingsPanels.video.estimatedPrice")} color={theme.node.muted}>
                        <div className="text-sm" style={{ color: theme.node.text }} title={priceHint || undefined}>
                            {price === null ? "-" : `≈ ￥${price.toFixed(4)}`}
                        </div>
                    </SettingGroup>
                ) : (
                    <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            {videoModeOptions.map((item) => (
                                <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                    {t(`settingsPanels.video.modes.${item.labelKey}`)}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                )}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${parseVideoResolution(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string, capability?: { seconds: { min: number; max: number; step?: number }; defaultSeconds: number } | null) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    // 节点里存的秒数可能超出当前模型范围（例如换了模型），摘要要显示钳制后的真实值。
    if (capability) return `${clampRangeSeconds(capability, value)}s`;
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" ? "reference" : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function clampRangeSeconds(capability: { seconds: { min: number; max: number; step?: number }; defaultSeconds: number }, value: string) {
    const step = capability.seconds.step || 1;
    const requested = Math.floor(Number(value) || capability.defaultSeconds);
    const bounded = Math.min(capability.seconds.max, Math.max(capability.seconds.min, requested));
    return capability.seconds.min + Math.round((bounded - capability.seconds.min) / step) * step;
}

/**
 * 秒数这一行的小字说明：讲清楚为什么时长不能随便调。
 * - 按条计费的模型，秒数不影响价格
 * - 时长写死的模型，直接说明固定多少秒
 * - 只能取离散值的模型，把可选值列出来
 */
function buildSecondsNote(capability: VideoModelCapability | null, seconds: number, resolution: string, fixedSeconds: boolean) {
    if (!capability) return "";
    const parts: string[] = [];
    // 价格未知时不能声称「按条计费」，那是从价格表推出来的结论。
    if (!capability.priceUnknown && videoModelPrice(capability, resolution, false).kind === "per_call") parts.push(i18n.t("settingsPanels.video.perCall"));
    if (fixedSeconds) {
        parts.push(i18n.t("settingsPanels.video.fixedSeconds", { seconds }));
    } else {
        const step = capability.seconds.step || 1;
        if (step > 1) {
            const values: number[] = [];
            for (let value = capability.seconds.min; value <= capability.seconds.max; value += step) values.push(value);
            parts.push(i18n.t("settingsPanels.video.stepSeconds", { values: values.join(" / ") }));
        }
    }
    return parts.join(" · ");
}

/** 倍率展示：整数不加小数点，小数最多两位（0.85 / 1.25 / 2）。 */
function formatRatio(value: number) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function SecondsInput({ value, min, max, theme, onCommit }: { value: number; min: number; max: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.min(max, Math.max(min, Math.floor(Number(input.value) || min)));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
