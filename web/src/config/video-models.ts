// Per-model video capability and price table for the Ark-compatible gateway.
// Capabilities come from the gateway's model page: supported resolutions,
// duration range, and how many reference images / videos / audios a model
// accepts. Prices are the discounted per-million-token rates, or the per-call
// price for models billed per request. Nothing here reaches the gateway: the
// UI uses it to offer only valid options and to estimate the charge.

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

export function videoModelCapability(model: string): VideoModelCapability | null {
    // model 可能带渠道前缀 "channelId::modelName"，先剥掉前缀。
    const name = model.includes("::") ? model.slice(model.lastIndexOf("::") + 2) : model;
    return Object.prototype.hasOwnProperty.call(videoModelCapabilities, name) ? videoModelCapabilities[name] : null;
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
};
