// Per-model video capability and price table for the Ark-compatible gateway.
// Capabilities come from the gateway's model page: supported resolutions,
// duration range, and how many reference images / videos / audios a model
// accepts. Prices are the discounted per-million-token rates, or the per-call
// price for models billed per request. Nothing here reaches the gateway: the
// UI uses it to offer only valid options and to estimate the charge.
//
// 能力数据现在有两个来源，优先级从高到低：
//   1. 网关目录 /api/user/models/catalog（后端按插件声明 + models.capabilities 解析）
//   2. 下面这张内置表（目录没拉到、或目录里没有这个模型时兜底）
// 加新上游模型不需要改这里，只要后端插件/后台能力声明写好，前端就能渲染。
// 价格目前仍只来自内置表：目录只带计费方式与示例用量，不带金额。
import { catalogVariant, type CatalogCapability, type CatalogVariant } from "@/services/api/model-catalog";
import { videoRatioOptions } from "@/lib/media-size";

export type VideoProtocol = "ark" | "openai" | "qora";

export type VideoModelPrice =
    | { kind: "per_token"; noReference: number; withReference: number }
    | { kind: "per_call"; price: number }
    | { kind: "per_second"; pricePerSecond: number };

// Qora per-second price type (credits/second, 10 credits = ¥1 = $0.14 approx)
// We store the price in CNY/second for display; billing expressions use raw credits.
export type VideoModelCapability = {
    label: string;
    protocol: VideoProtocol;
    /**
     * false 表示该模型已下架：仍保留能力数据用于历史节点展示，但不再参与
     * 能力判定、默认值回退和模型列表，避免已停用的模型被当成可用视频模型。
     */
    available?: boolean;
    /**
     * true 表示能力来自目录但目录没有金额：只能渲染参数，不能显示预估价。
     * 调用方必须把价格显示成「-」而不是 ￥0，否则用户会以为免费。
     */
    priceUnknown?: boolean;
    /** Resolution tiers in ascending order; each maps to a 16:9 and a 9:16 size. */
    resolutions: string[];
    ratios: string[];
    /** Inclusive duration range; `step` defaults to 1 second. */
    seconds: { min: number; max: number; step?: number };
    defaultSeconds: number;
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    /** Prices by resolution tier, per call. */
    price: Record<string, VideoModelPrice> & { default?: VideoModelPrice };
};

// 界面只渲染这两档，目录里出现别的档位时不能直接塞进来（会让分辨率网格空掉）。
const KNOWN_RESOLUTION_TIERS = ["480", "720", "1080"];
const KNOWN_RATIOS: string[] = videoRatioOptions.map((item) => item.value);

function normalizeResolutionTier(value: string) {
    const tier = String(value || "").trim().replace(/[pP]$/, "");
    return /^\d+$/.test(tier) ? tier : "";
}

function videoProtocolOf(value: string | undefined): VideoProtocol | null {
    return value === "ark" || value === "openai" || value === "qora" ? value : null;
}

/**
 * 判断一份能力声明描述的是不是视频：优先看 modality.output，没声明时按字段推断。
 * 少了这一步，gpt-image-1 这类图片模型会被当成视频模型塞进视频选择器。
 */
function isVideoCapability(capability: CatalogCapability) {
    const output = capability.modality?.output;
    if (output && output.length) return output.includes("video");
    return Boolean(capability.fields.resolution || capability.fields.seconds);
}

/**
 * 把目录里的字段描述翻译成界面用的能力形状。
 * 只做「声明了什么就渲染什么」，不给缺失项编造默认值：缺的关键项由调用方回退到内置表。
 */
function catalogVideoCapability(variant: CatalogVariant): VideoModelCapability | null {
    const capability = variant.capabilities;
    if (!capability || !isVideoCapability(capability)) return null;
    const protocol = videoProtocolOf(capability.protocol);
    // 协议决定提交到哪个上游，认不出来就没法发请求，交给内置表兜底。
    if (!protocol) return null;

    const resolutions = (capability.fields.resolution?.enum ?? []).map(normalizeResolutionTier).filter((tier) => KNOWN_RESOLUTION_TIERS.includes(tier));
    const ratios = (capability.fields.ratio?.enum ?? []).filter((ratio) => KNOWN_RATIOS.includes(ratio));
    const secondsField = capability.fields.seconds;
    const seconds = secondsField
        ? {
              min: Number(secondsField.min ?? secondsField.default ?? 0),
              max: Number(secondsField.max ?? secondsField.default ?? 0),
              step: secondsField.step && secondsField.step > 0 ? secondsField.step : 1,
          }
        : null;
    if (!resolutions.length || !ratios.length || !seconds || !Number.isFinite(seconds.min) || !Number.isFinite(seconds.max) || seconds.max < seconds.min) {
        return null;
    }
    const defaultSeconds = Number(secondsField?.default);
    const limitOf = (key: string) => {
        const value = Number(capability.fields[key]?.max);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    };

    return {
        label: variant.display_name || variant.model,
        protocol,
        priceUnknown: true,
        resolutions,
        ratios,
        seconds,
        defaultSeconds: Number.isFinite(defaultSeconds) ? Math.min(seconds.max, Math.max(seconds.min, defaultSeconds)) : seconds.min,
        maxImages: limitOf("max_images"),
        maxVideos: limitOf("max_videos"),
        maxAudios: limitOf("max_audios"),
        price: {},
    };
}

function builtinCapability(name: string) {
    return Object.prototype.hasOwnProperty.call(videoModelCapabilities, name) ? videoModelCapabilities[name] : null;
}

/**
 * 进面板时默认落到哪一档分辨率。
 *
 * 动态从目录能力声明读取 default 分辨率；若按秒计费且提供多档分辨率但未显式指定
 * default，则默认落到最低档，保证下拉报价与面板实价一致。
 */
export function videoModelDefaultResolution(model: string): string | undefined {
    const name = model.includes("::") ? model.slice(model.lastIndexOf("::") + 2) : model;
    const variant = catalogVariant(name);
    const capability = variant?.capabilities;
    if (!capability) return undefined;
    const resField = capability.fields?.resolution;
    const explicitDefault = typeof resField?.default === "string"
        ? resField.default.trim().replace(/p$/i, "")
        : "";
    if (explicitDefault) return explicitDefault;
    if (capability.billingUnit === "second" && variant) {
        const cap = catalogVideoCapability(variant);
        if (cap && cap.resolutions.length > 1) return cap.resolutions[0];
    }
    return undefined;
}

export function videoModelCapability(model: string): VideoModelCapability | null {
    // model 可能带渠道前缀 "channelId::modelName"，先剥掉前缀。
    const name = model.includes("::") ? model.slice(model.lastIndexOf("::") + 2) : model;
    const builtin = builtinCapability(name);
    const variant = catalogVariant(name);
    const fromCatalog = variant ? catalogVideoCapability(variant) : null;
    if (!fromCatalog) return builtin;
    if (!builtin) return fromCatalog;
    // 目录里出现了这个模型，说明它现在是可用的——内置表里的 available:false 可能已经过期。
    // 能力以目录为准，价格仍然只能用内置表的（目录不带金额）。
    return {
        ...builtin,
        ...fromCatalog,
        label: variant?.display_name || builtin.label,
        available: true,
        priceUnknown: false,
        price: builtin.price,
    };
}


/**
 * 把时长裁到当前模型真正支持的范围。
 *
 * 面板显示时本来就会按能力 clamp，但配置里存的仍是上一个档位的原值；提交时不裁，
 * 就会把 30 秒发给只支持 4~15 秒的档位，上游直接 400「时长不可用」。
 */
export function clampSecondsToModel(model: string, value: string): string {
    const raw = String(value ?? "").trim();
    // -1 是「自动时长」，交给上游决定，不要裁成具体秒数。
    if (raw === "" || raw === "-1") return raw;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return raw;
    const capability = videoModelCapability(model);
    if (!capability) return raw;
    const { min, max, step } = capability.seconds;
    const stride = step && step > 0 ? step : 1;
    const bounded = Math.min(max, Math.max(min, Math.round(seconds)));
    const snapped = min + Math.round((bounded - min) / stride) * stride;
    return String(Math.min(max, Math.max(min, snapped)));
}

export function videoModelPrice(capability: VideoModelCapability, resolution: string, hasReferenceVideo: boolean): VideoModelPrice {
    const entry = capability.price[resolution] || capability.price.default;
    if (!entry) return { kind: "per_call", price: 0 };
    return entry;
}

// Ark bills on tokens, not seconds: tokens = seconds x width x height x 24 / 1024.
// The estimate is what the gateway reserves; the completion hook settles to the
// measured token count.
export function estimateVideoTokens(seconds: number, width: number, height: number) {
    return (seconds * width * height * 24) / 1024;
}

// 后端预留额度时按分辨率档位的最大像素估算，前端用同一套口径，避免显示值和扣费不一致。
const tierMaxPixels: Record<string, [number, number]> = {
    "480": [854, 480],
    "720": [1280, 720],
    "1080": [1920, 1080],
};

export function estimateVideoPrice(capability: VideoModelCapability, options: { seconds: number; resolution: string; hasReferenceVideo: boolean }) {
    const price = videoModelPrice(capability, options.resolution, options.hasReferenceVideo);
    if (price.kind === "per_call") return price.price;
    if (price.kind === "per_second") return price.pricePerSecond * options.seconds;
    const size = tierMaxPixels[options.resolution] || tierMaxPixels["720"];
    const unit = options.hasReferenceVideo ? price.withReference : price.noReference;
    return (estimateVideoTokens(options.seconds, size[0], size[1]) * unit) / 1_000_000;
}

const reference415 = { min: 4, max: 15, step: 1 };

export const videoModelCapabilities: Record<string, VideoModelCapability> = {
    "model-359237364507209728": {
        label: "Seedance 2.5",
        protocol: "ark",
        available: false,
        resolutions: ["480", "720", "1080"],
        ratios: ["16:9", "9:16"],
        seconds: { min: 4, max: 30, step: 1 },
        defaultSeconds: 5,
        maxImages: 16,
        maxVideos: 10,
        maxAudios: 10,
        price: {
            "480": { kind: "per_token", noReference: 66.5, withReference: 39.9 },
            "720": { kind: "per_token", noReference: 66.5, withReference: 39.9 },
            "1080": { kind: "per_token", noReference: 73.15, withReference: 43.7 },
        },
    },
    "model-359263564038410254": {
        label: "Seedance 2.0",
        protocol: "ark",
        available: false,
        resolutions: ["480", "720", "1080"],
        ratios: ["16:9", "9:16"],
        seconds: reference415,
        defaultSeconds: 5,
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
        price: {
            "480": { kind: "per_token", noReference: 43.7, withReference: 26.6 },
            "720": { kind: "per_token", noReference: 43.7, withReference: 26.6 },
            "1080": { kind: "per_token", noReference: 48.45, withReference: 29.45 },
        },
    },
    "model-359263564038410247": {
        label: "Seedance 2.0 Fast",
        protocol: "ark",
        available: false,
        resolutions: ["480", "720"],
        ratios: ["16:9", "9:16"],
        seconds: reference415,
        defaultSeconds: 5,
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
        price: {
            "480": { kind: "per_token", noReference: 25.9, withReference: 15.4 },
            "720": { kind: "per_token", noReference: 25.9, withReference: 15.4 },
        },
    },
    "model-359263564038410240": {
        label: "Seedance 2.0 Mini",
        protocol: "ark",
        available: false,
        resolutions: ["480", "720"],
        ratios: ["16:9", "9:16"],
        seconds: reference415,
        defaultSeconds: 5,
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
        price: {
            "480": { kind: "per_token", noReference: 9.2, withReference: 5.6 },
            "720": { kind: "per_token", noReference: 9.2, withReference: 5.6 },
        },
    },
    "model-2113237671521415168": {
        label: "Seedance 2.0 fast-I",
        protocol: "ark",
        available: false,
        resolutions: ["720"],
        ratios: ["16:9"],
        seconds: { min: 5, max: 15, step: 5 },
        defaultSeconds: 5,
        maxImages: 9,
        maxVideos: 0,
        maxAudios: 0,
        price: { "720": { kind: "per_call", price: 2.46 } },
    },
    "model-2113239440460738561": {
        label: "Seedance 2.0 mini-I",
        protocol: "ark",
        available: false,
        resolutions: ["720"],
        ratios: ["16:9"],
        seconds: { min: 5, max: 15, step: 5 },
        defaultSeconds: 5,
        maxImages: 9,
        maxVideos: 0,
        maxAudios: 0,
        price: { "720": { kind: "per_call", price: 1.65 } },
    },
    // ── Qora models ──────────────────────────────────────────────────────────
    // Prices are in CNY (积分/条 or 积分/秒); 10 credits = ¥1.
    // Per-call models: price in CNY.  Per-second models: pricePerSecond in CNY/s.
    "qr-v042": {
        label: "Seedance 2.5 · 骨折版满血10图",
        protocol: "qora",
        resolutions: ["720", "1080"],
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        seconds: { min: 30, max: 30 },
        defaultSeconds: 30,
        maxImages: 10, maxVideos: 0, maxAudios: 0,
        price: { "720": { kind: "per_call", price: 5.5 }, "1080": { kind: "per_call", price: 7.0 } },
    },
    "qr-v040": {
        label: "Seedance 2.0 · 满血按条（480p）",
        protocol: "qora",
        resolutions: ["480"],
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        seconds: { min: 4, max: 15 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 3, maxAudios: 3,
        price: { default: { kind: "per_call", price: 3.0 } },
    },
    "qr-v035": {
        label: "Seedance 2.0 Fast · 短片特惠",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        seconds: { min: 10, max: 10 },
        defaultSeconds: 10,
        maxImages: 9, maxVideos: 0, maxAudios: 0,
        price: { default: { kind: "per_call", price: 1.5 } },
    },
    "qr-v036": {
        label: "Seedance 2.0 Fast · 按条特惠",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["16:9", "9:16"],
        seconds: { min: 5, max: 15, step: 5 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 0, maxAudios: 0,
        price: { default: { kind: "per_call", price: 2.5 } },
    },
    "qr-v037": {
        label: "Seedance 2.0 · 满血按条",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        seconds: { min: 4, max: 15 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 9, maxAudios: 9,
        price: { default: { kind: "per_call", price: 3.9 } },
    },
    "qr-v007": {
        label: "Seedance 2.5 · 特惠官方480p",
        protocol: "qora",
        resolutions: ["480"],
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        seconds: { min: 4, max: 30 },
        defaultSeconds: 5,
        maxImages: 30, maxVideos: 10, maxAudios: 10,
        price: { default: { kind: "per_second", pricePerSecond: 0.35 } },
    },
    "qr-v012": {
        label: "Seedance 2.5 · 原生720",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        seconds: { min: 4, max: 30 },
        defaultSeconds: 5,
        maxImages: 30, maxVideos: 0, maxAudios: 10,
        price: { default: { kind: "per_second", pricePerSecond: 0.45 } },
    },
    "qr-v018": {
        label: "Seedance 2.0 · 竖屏特惠",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["9:16"],
        seconds: { min: 4, max: 15 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 3, maxAudios: 3,
        price: { default: { kind: "per_second", pricePerSecond: 0.2 } },
    },
    "qr-v019": {
        label: "Seedance 2.0 Mini 竖屏特惠",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["9:16"],
        seconds: { min: 4, max: 15 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 3, maxAudios: 3,
        price: { default: { kind: "per_second", pricePerSecond: 0.1 } },
    },
    "qr-v020": {
        label: "Seedance 2.0 Fast 竖屏特惠",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["9:16"],
        seconds: { min: 4, max: 15 },
        defaultSeconds: 5,
        maxImages: 9, maxVideos: 3, maxAudios: 3,
        price: { default: { kind: "per_second", pricePerSecond: 0.15 } },
    },
    // 70 积分/条（10 积分 = ¥1，即 ¥7.00/条）；支持 21:9 超宽屏，时长 5–30 秒连续可选。
    "qr-v044": {
        label: "Seedance 2.5 · 满血全能2.5",
        protocol: "qora",
        resolutions: ["720"],
        ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        seconds: { min: 5, max: 30 },
        defaultSeconds: 5,
        maxImages: 30, maxVideos: 10, maxAudios: 10,
        price: { default: { kind: "per_call", price: 7.0 } },
    },
};
