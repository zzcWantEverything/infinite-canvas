import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { encodeChannelModel, guessCapability, modelOptionLabel, modelOptionName, normalizedBaseUrlMatch, pickPreferredImageModelOption, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchUserModels } from "@/services/api/auth";
import { reportApiError } from "@/services/api/http";
import { catalogGroupOf, catalogVariant, modelCatalogVersion, subscribeModelCatalog } from "@/services/api/model-catalog";
import { fetchPricingSnapshot, type PricingModelEntry, type PricingSnapshot } from "@/services/api/pricing";
import { groupModelOptions } from "@/lib/model-picker-groups";
import { estimateModelPrice } from "@/lib/model-price";
import { videoModelCapability, videoModelDefaultResolution } from "@/config/video-models";

const USER_MODELS_TTL = 60_000;
const DEFAULT_MODEL_VALUE = "__default__";

let cachedModelsKey = "";
let cachedModels: string[] | null = null;
let cachedModelsAt = 0;
let inflightModels: { key: string; promise: Promise<string[]> } | null = null;

async function loadCachedUserModels(baseUrl: string, token: string): Promise<string[]> {
    const key = `${baseUrl.trim().replace(/\/+$/, "")}::${token}`;
    const now = Date.now();
    if (cachedModels && cachedModelsKey === key && now - cachedModelsAt < USER_MODELS_TTL) return cachedModels;
    if (inflightModels && inflightModels.key === key) return inflightModels.promise;
    const promise = fetchUserModels(baseUrl, token)
        .then((models) => {
            if (models.length) {
                cachedModelsKey = key;
                cachedModels = models;
                cachedModelsAt = Date.now();
            }
            return models;
        })
        .finally(() => {
            if (inflightModels?.promise === promise) inflightModels = null;
        });
    inflightModels = { key, promise };
    return promise;
}

export function invalidateUserModelsCache() {
    cachedModelsKey = "";
    cachedModels = null;
    cachedModelsAt = 0;
    inflightModels = null;
}

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    allowDefault?: boolean;
    defaultLabel?: string;
    disabled?: boolean;
    onMenuOpenChange?: (open: boolean) => void;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, allowDefault = false, defaultLabel, disabled = false, onMenuOpenChange, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const session = useUserStore((state) => state.session);

    // 模型列表直接从服务器拉取，并用当前渠道 id 编码，确保 resolveModelChannel 能找到有效凭据。
    // /api/user/models 使用 UserAuth（session token），apiKey 是渠道凭据，两者不互通。
    // 图片和视频都走这条路，否则本地配置里只写了一个模型时，下拉里就只见得到那一个。
    const [serverModels, setServerModels] = useState<string[]>([]);
    // 依赖里不放 token：access token 每次续期都会换新，挂上去会让下拉在后台反复重拉目录。
    const hasToken = Boolean(session?.token);
    useEffect(() => {
        const live = useUserStore.getState().session;
        if (!capability || !live?.baseUrl || !live?.token) return;
        const matchingChannel = config.channels.find((ch) => normalizedBaseUrlMatch(ch.baseUrl, live.baseUrl)) ?? config.channels[0];
        const channelId = matchingChannel?.id ?? "default";
        loadCachedUserModels(live.baseUrl, live.token)
            .then((models) => {
                if (!models.length) return;
                setServerModels(models.map((m) => encodeChannelModel(channelId, m)));
            })
            .catch(reportApiError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capability, session?.baseUrl, hasToken]);

    const configOptions = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);

    // 服务器列表优先，按能力过滤后为空才退回配置列表。
    // 视频用内置能力表（含下架判定），其余能力先看目录的 modality.output，再退回关键词猜测。
    const serverOptions = useMemo(() => {
        if (!capability || !serverModels.length) return [];
        if (capability === "video") return serverModels.filter((model) => isVideoModel(modelOptionName(model)));
        return serverModels.filter((model) => capabilityOf(modelOptionName(model)) === capability);
    }, [capability, serverModels]);
    const usingServerOptions = serverOptions.length > 0;
    const options = usingServerOptions ? serverOptions : configOptions;

    // 网关目录把同一款模型的多条线路归到一张卡片（variant_group），运营也会直接在展示名里
    // 写分组（「高清视觉 · sd2.5 1080P」）。两种写法都按同一套规则折叠：前缀做组标题，
    // 条目只显示线路名，避免同一串文字出现两次。
    const catalogVersion = useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
    const optionGroups = useMemo(
        () =>
            groupModelOptions(
                options.map((option) => {
                    const name = modelOptionName(option);
                    const card = catalogGroupOf(name);
                    return {
                        value: option,
                        name,
                        card: card ? { key: card.model, displayName: card.display_name, variantCount: card.variants.length } : null,
                        variantDisplayName: catalogVariant(name)?.display_name ?? null,
                    };
                }),
            ),
        [options, catalogVersion],
    );

    // 价格快照与视频面板同源（/api/pricing 计费表达式 × 分组倍率），下拉里报的价位
    // 必须和面板算出来的一致，否则用户会以为哪边算错了。
    const [pricing, setPricing] = useState<PricingSnapshot | null>(null);
    useEffect(() => {
        if (!session?.baseUrl) return;
        let alive = true;
        fetchPricingSnapshot(session.baseUrl)
            .then((snapshot) => {
                if (alive) setPricing(snapshot);
            })
            .catch(reportApiError);
        return () => {
            alive = false;
        };
    }, [session?.baseUrl]);

    // 条目副标题（参考素材上限）+ 右侧价位。只写模型真正声明过的东西：目录里没写的字段
    // 当「没声明」跳过，不编成「不支持」，否则会把能传视频的模型标成不能传。
    const optionSummaries = useMemo(() => {
        const summaries = new Map<string, { detail: string; price: string }>();
        const unsupported = t("settingsPanels.model.detailUnsupported");
        for (const option of options) {
            const name = modelOptionName(option);
            const limits = declaredReferenceLimits(name);
            const parts: string[] = [];
            const push = (count: number | null, key: string) => {
                if (count === null) return;
                parts.push(count > 0 ? t(key, { n: count }) : unsupported);
            };
            push(limits.images, "settingsPanels.model.detailImages");
            push(limits.videos, "settingsPanels.model.detailVideos");
            push(limits.audios, "settingsPanels.model.detailAudios");
            // 价格算不出来（表达式引用了这里不知道的用量）时留空，不猜。
            const entry = pricing?.models.get(name);
            const estimate = pricing && entry ? estimateOptionPrice(entry, name, pricing.ratio, config.vquality) : null;
            // 算不出具体金额（图片模型按 token 用量计费）时至少说明计费方式，别留空白。
            const price = estimate
                ? t(estimate.unit === "call" ? "settingsPanels.model.pricePerCall" : "settingsPanels.model.pricePerSecond", { price: formatMoney(estimate.value) })
                : entry
                  ? t("settingsPanels.model.pricePerUsage")
                  : "";
            if (parts.length || price) summaries.set(option, { detail: parts.join(" · "), price });
        }
        return summaries;
    }, [options, pricing, catalogVersion, t, config.vquality]);

    // 当有服务器模型列表时，把 current 规范化到列表格式，保证 Radix Select 能找到匹配项。
    const current = useMemo(() => {
        const raw = value || "";
        if (!usingServerOptions) return raw;
        if (options.includes(raw)) return raw;
        // 提取纯模型名后查找对应编码
        const modelName = modelOptionName(raw);
        return options.find((m) => modelOptionName(m) === modelName) ?? "";
    }, [usingServerOptions, options, value]);

    // 节点上残留的模型名不在服务端列表里（例如已下架的 ark 模型）时，自动纠正为列表首个可用模型。
    // 否则界面显示为空，但节点里仍存着旧模型名，用户不重新选就会把已下线的模型提交出去。
    // 若允许「跟随默认」（allowDefault），未选择时保持空值，仅当已选的自定义模型下线时清空回默认。
    useEffect(() => {
        if (!usingServerOptions || !options.length) return;
        if (allowDefault) {
            if (value && !current) onChange("");
            return;
        }
        if (current) return;
        const fallback = capability === "image" ? pickPreferredImageModelOption(options) : "";
        onChange(fallback || options[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [usingServerOptions, current, options, allowDefault, value, capability]);
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    const defaultText = defaultLabel || pickerPlaceholder;
    const triggerText = current ? modelOptionLabel(config, current) : allowDefault && defaultLabel ? defaultLabel : pickerPlaceholder;

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) {
                setOpen(false);
                onMenuOpenChange?.(false);
            }
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId, onMenuOpenChange]);

    return (
        <Select
            disabled={disabled}
            open={open}
            value={allowDefault ? current || DEFAULT_MODEL_VALUE : current}
            onOpenChange={(nextOpen) => {
                // 视频能力：服务器已提供模型列表时不触发配置弹窗；其他能力保留原逻辑。
                if (nextOpen && !options.length && config.channelMode === "local" && capability !== "video") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
                onMenuOpenChange?.(nextOpen);
            }}
            onValueChange={(next) => onChange(allowDefault && next === DEFAULT_MODEL_VALUE ? "" : next)}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={triggerText}
            >
                {allowDefault && !current ? <Cpu className="size-3.5 shrink-0 opacity-50" /> : <ModelIcon model={current} />}
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{triggerText}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-[26rem] max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {allowDefault ? (
                    <SelectItem value={DEFAULT_MODEL_VALUE} textValue={defaultText} className="mb-1 border-b border-border/60 pb-1.5 text-muted-foreground">
                        {defaultText}
                    </SelectItem>
                ) : null}
                {optionGroups.length ? (
                    optionGroups.map((group) => {
                        if (!group.header) {
                            const only = group.items[0];
                            const summary = optionSummaries.get(only.value);
                            return (
                                <SelectItem key={only.value} value={only.value} textValue={modelOptionLabel(config, only.value)}>
                                    <ModelLabel config={config} model={only.value} detail={summary?.detail} price={summary?.price} />
                                </SelectItem>
                            );
                        }
                        return (
                            <SelectGroup key={group.key}>
                                <SelectLabel>{group.label}</SelectLabel>
                                {group.items.map((item) => {
                                    const summary = optionSummaries.get(item.value);
                                    return (
                                        <SelectItem key={item.value} value={item.value} textValue={modelOptionLabel(config, item.value)}>
                                            <ModelLabel config={config} model={item.value} label={item.label} detail={summary?.detail} price={summary?.price} />
                                        </SelectItem>
                                    );
                                })}
                            </SelectGroup>
                        );
                    })
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

/**
 * 参考素材上限。优先读目录里的原始声明（`catalogVariant` 的 fields），目录没拉到才用内置
 * 能力表兜底——内置表三个字段都写死了，0 就是真的不支持；目录里缺字段只是没声明。
 */
function declaredReferenceLimits(modelName: string) {
    const fields = catalogVariant(modelName)?.capabilities?.fields;
    if (fields) {
        const read = (key: "max_images" | "max_videos" | "max_audios") => {
            const max = fields[key]?.max;
            return typeof max === "number" ? max : null;
        };
        return { images: read("max_images"), videos: read("max_videos"), audios: read("max_audios") };
    }
    const builtin = videoModelCapability(modelName);
    return builtin ? { images: builtin.maxImages, videos: builtin.maxVideos, audios: builtin.maxAudios } : { images: null, videos: null, audios: null };
}

/** 估值用的分辨率档位：模型声明的最低档 → 计费 schema 的第一个枚举值 → 720 兜底。 */
/**
 * 视频节点是否该显示这个模型。目录（catalog）的 capabilities.modality.output 是权威：
 * ["video"] 才是视频；目录里没这个模型（还没拉到）时先保留，等目录到了再精过滤；
 * 目录有这个模型但没声明 output（如手动加的 GPT 生图渠道），退回关键词猜测。
 */
function isVideoModel(name: string): boolean {
    const variant = catalogVariant(name);
    if (!variant) return true;
    const output = variant.capabilities?.modality?.output;
    if (output && output.length) return output.includes("video");
    const known = videoModelCapability(name);
    if (known) return known.available !== false;
    return guessCapability(name) === "video";
}

/**
 * 报哪一档的分辨率价。以前固定取模型最低档，于是「0.18/秒」的下拉报价和面板里
 * 按 720P 算出来的实价对不上（0.12 vs 0.21）。现在优先用用户在视频面板里当前选的
 * 档位，模型不支持该档时才退回它自己的最低档。
 */
function optionResolution(modelName: string, entry: PricingModelEntry, preferred?: string) {
    const capability = videoModelCapability(modelName);
    const tiers = capability?.resolutions.length
        ? capability.resolutions
        : Array.isArray(entry.usageSchema?.resolution?.enum)
          ? entry.usageSchema.resolution.enum.map((value) => String(value).replace(/p$/i, ""))
          : [];
    // 指定了默认档的模型（分档价差大）永远按那一档报价，和选中模型后落到的档位一致。
    const forced = videoModelDefaultResolution(modelName);
    if (forced && tiers.includes(forced)) return forced;
    const wanted = String(preferred || "").replace(/p$/i, "");
    if (wanted && tiers.includes(wanted)) return wanted;
    if (tiers.length) return tiers[0];
    return "720";
}

/**
 * 下拉里的价位。先看是不是按次计价的模型；再看表达式跟时长有没有关系——同样的分辨率下
 * 1 秒和 2 秒一个价，说明这条表达式是一口价（`tier("base", 5.5)` 这种），得按「/次」报，
 * 说成每秒会把用户吓跑；价随时长涨的才按「/秒」报。分辨率越高通常越贵，所以文案带「约」。
 */
function estimateOptionPrice(entry: PricingModelEntry, modelName: string, ratio: number, preferredResolution?: string): { unit: "call" | "second"; value: number } | null {
    if (entry.modelPrice > 0) return { unit: "call", value: entry.modelPrice * ratio };
    const resolution = optionResolution(modelName, entry, preferredResolution);
    const oneSecond = estimateModelPrice(entry, { seconds: 1, resolution });
    if (oneSecond === null || !Number.isFinite(oneSecond) || oneSecond <= 0) {
        // 图片模型按 token 用量计费（p / cr / img / c），前端推不出一次生成用多少 token，
        // 借目录 pricing.examples 的示例用量算一次参考价，仍算不出就不报价格。
        const exampleCost = estimateFromCatalogExample(entry, modelName, resolution);
        return exampleCost === null ? null : { unit: "call", value: exampleCost * ratio };
    }
    const twoSeconds = estimateModelPrice(entry, { seconds: 2, resolution });
    const byDuration = twoSeconds !== null && twoSeconds > oneSecond;

    // 单位以上游能力声明为准（billingUnit: second / request / token）。拿不到目录时
    // 才退回「1 秒和 2 秒是否同价」：这种启发式对「起步价 + 之后按秒」的阶梯档位
    // （如 sd2.5-CD 480P：≤5 秒一口价 1.5，之后每秒 +0.28）会把按秒误判成按次。
    const billingUnit = catalogVariant(modelName)?.capabilities?.billingUnit;
    const unit: "call" | "second" = billingUnit === "second" ? "second" : billingUnit === "request" || billingUnit === "token" ? "call" : byDuration ? "second" : "call";
    return { unit, value: oneSecond * ratio };
}

/** 0.045 → "0.045"，0.315 → "0.315"，42.9 → "42.90"：金额最小单位是分，≥1 元一律两位。 */
/** 目录声明的输出模态优先，没声明时按模型名关键词猜。 */
function capabilityOf(name: string): ModelCapability {
    const outputs = catalogVariant(name)?.capabilities?.modality?.output;
    if (Array.isArray(outputs) && outputs.length) {
        if (outputs.includes("video")) return "video";
        if (outputs.includes("image")) return "image";
        if (outputs.includes("audio")) return "audio";
    }
    return guessCapability(name);
}

function estimateFromCatalogExample(entry: PricingModelEntry, modelName: string, resolution: string): number | null {
    const facts = catalogVariant(modelName)?.pricing?.examples?.[0]?.facts;
    if (!facts) return null;
    const extra: Record<string, number> = {};
    for (const [key, value] of Object.entries(facts)) {
        const numeric = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(numeric)) extra[key] = numeric;
    }
    if (!Object.keys(extra).length) return null;
    const cost = estimateModelPrice(entry, { seconds: 1, resolution, extra });
    return cost !== null && cost > 0 ? cost : null;
}

function formatMoney(value: number) {
    // 展示价都是「表达式 × 分组倍率(1.5)」，常落到 0.735 / 1.245 这种三位小数，
    // 直接原样打印会出现「约 ¥1.245/秒」这种读不动的数字。1 元以上收到分；
    // 1 元以下保留三位——按秒的单价收成 0.32 再乘 30 秒会比实扣多出 1.6%。
    const rounded = Number(value.toFixed(3));
    return rounded >= 1 ? rounded.toFixed(2) : String(Number(value.toFixed(3)));
}

function ModelLabel({ config, model, label, detail, price }: { config: AiConfig; model: string; label?: string; detail?: string; price?: string }) {
    return (
        <span className="flex w-full min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="min-w-0 flex-1">
                <span className="block truncate">{label || modelOptionLabel(config, model)}</span>
                {detail ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span> : null}
            </span>
            {price ? <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">{price}</span> : null}
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
