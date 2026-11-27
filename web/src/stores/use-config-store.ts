import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import { videoModelCapability, videoModelDefaultResolution } from "@/config/video-models";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { catalogGroupOf, catalogVariant } from "@/services/api/model-catalog";

import i18n from "@/i18n";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
    imgbedUrl: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "imgbed" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";

function siteOrigin() {
    return typeof window === "undefined" ? "" : window.location.origin;
}

function isLoopbackHost(hostname: string) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isIpv4Host(hostname: string) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * 纠正历史配置里写死的接口地址：指向同一台机器的其它端口/协议（例如本机 docker 的 :3000），
 * 或指向本机地址但在别处访问时，统一改为当前站点 origin。
 * 指向其它域名/主机的配置保持原样，外部 API（OpenAI、Gemini 官方、第三方中转）不受影响。
 */
export function normalizeBaseUrl(baseUrl: string) {
    const trimmed = (baseUrl || "").trim();
    const origin = siteOrigin();
    if (!trimmed || !origin || origin === "null") return trimmed;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return trimmed;
    }
    const site = new URL(origin);
    if (url.hostname === site.hostname && url.origin !== site.origin) return origin;
    if (isLoopbackHost(url.hostname) && url.hostname !== site.hostname) return origin;
    // 站点切到 HTTPS 后，历史配置里写死的 http://IP 会被浏览器当混合内容拦掉，按当前站点处理。
    if (site.protocol === "https:" && url.protocol === "http:" && isIpv4Host(url.hostname)) return origin;
    return trimmed;
}

const OPENAI_BASE_URL = siteOrigin();
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "tt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::model-359263564038410254",
    imageModel: "default::tt-image-2",
    videoModel: "default::qr-v007",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::tt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "16:9",
    background: "",
    count: "1",
    canvasImageCount: "1",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
    imgbedUrl: "/imgbed",
};

// 旧的图床默认值是写死的 http://<IP>:8081，站点迁到 HTTPS 后会被浏览器按混合内容拦截。
// 统一收敛到同源路径 /imgbed（由 nginx 反代到图床服务），已有用户的本地配置也一并迁移。
const LEGACY_IMGBED_URL = "http://119.45.0.224:8081";
function normalizeImgbedUrl(url: string | undefined) {
    const value = (url || "").trim();
    if (!value) return defaultConfig.imgbedUrl;
    if (value.replace(/\/+$/, "").toLowerCase() === LEGACY_IMGBED_URL) return defaultConfig.imgbedUrl;
    return value;
}

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const known = videoModelCapability(name);
    // 已下架模型不再算视频模型，否则猜出来的能力会把它们重新塞回视频列表。
    if (known) return known.available === false ? "text" : "video";
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    // 视频能力表优先：视频模型列表来自 /api/user/models，不一定登记在渠道的模型列表里，
    // 渠道里也可能被 guessCapability 猜成文本。不认表会让选中的视频模型判成不支持视频，
    // 生成时回退到默认视频模型，提交出去就变成另一个渠道的模型。
    // 但已下架（available === false）的模型要判成不支持视频，否则旧节点上残留的
    // 下架模型名会被当成合法选择一直提交出去。
    const known = videoModelCapability(value);
    if (known) return known.available === false ? undefined : "video";
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    // 图片：服务器目录里的模型（miniKey tt-image-* / banana-* 等）不在本地 config.channels，
    // 用 modelMatchesCapability 会判成不可用而退回默认，表现为「选了不回显、生成还是旧模型」。
    // 图片节点选过的模型直接放行；真正的下架模型由 ModelPicker 的自动纠正（onChange 首个可用）兜住。
    if (capability === "image" && currentModel) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    // 视频：上面两级都可能指向已下架的模型（节点旧值、用户配置的默认值），
    // 这时退回当前仍可选的视频模型，避免继续把下架模型提交出去。
    if (capability === "video") {
        const selectable = selectableModelsByCapability(config, "video").filter((model) => videoModelCapability(model)?.available !== false);
        if (selectable.length) return selectable[0];
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** 默认生图模型优先级：优先 GPT 系 image-2（tt-image-2），其次 Image 2.6（tt-image-2.6），再退回其他有效 tt-image / gpt-image（排除已下线的 gpt-image-2）。 */
export function pickPreferredImageModelOption(options: string[]): string {
    return (
        options.find((model) => /(^|::)tt-image-2$/i.test(model)) ||
        options.find((model) => /(^|::)tt-image-2\.6$/i.test(model)) ||
        options.find((model) => /(^|::)tt-image/i.test(model)) ||
        options.find((model) => /(^|::)gpt-image(?!-2$)/i.test(model)) ||
        ""
    );
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => {
                    const config = { ...state.config, [key]: value };
                    // 切到「按分辨率分档计价」的模型时落到它的默认档：模型下拉报的是这一档的价，
                    // 不跟着切的话用户看到的单价和实际扣费会差一倍。
                    if (key === "videoModel") {
                        const raw = String(value ?? "");
                        const bare = raw.includes("::") ? raw.slice(raw.indexOf("::") + 2) : raw;
                        const preferred = videoModelDefaultResolution(bare);
                        if (preferred && preferred !== String(config.vquality)) {
                            config.vquality = preferred;
                            config.size = computeVideoSize(preferred, inferVideoRatio(config.size || "auto"));
                        }
                    }
                    return { config };
                }),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) set({ config: result.config });
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            // v1：图片默认比例从 1:1 改成 16:9。只把仍是旧默认值的配置升上来，
            // 用户自己选过 1:1 的话能在 v0→v1 之后保持不变（迁移只跑一次）。
            version: 3,
            migrate: (persisted, oldVersion) => {
                const state = persisted as { config?: Partial<AiConfig> } | undefined;
                if (!state?.config) return state;
                let config = { ...state.config };
                // v0 → v1：图片默认比例 1:1 → 16:9
                if (oldVersion < 1 && config.size === "1:1") config = { ...config, size: "16:9" };
                // v1 → v2：图片默认张数 3 → 1（只改老默认值，用户选过的不动）
                if (oldVersion < 2 && config.canvasImageCount === "3") config = { ...config, canvasImageCount: "1" };
                // v2 → v3：gpt-image-2 已下线，迁到 GPT 系 image-2（tt-image-2）；曾因旧默认值落到 banana-2.1 的也一并迁回。
                if (oldVersion < 3) {
                    if (Array.isArray(config.channels)) {
                        config = {
                            ...config,
                            channels: config.channels.map((channel) => ({
                                ...channel,
                                models: Array.isArray(channel.models)
                                    ? channel.models.map((item) => (item && item.name === "gpt-image-2" ? { ...item, name: "tt-image-2" } : item))
                                    : channel.models,
                            })),
                        };
                    }
                    if (!config.imageModel || /(^|::)(gpt-image-2|banana-2\.1)$/i.test(config.imageModel)) {
                        const prefix = config.imageModel && config.imageModel.includes("::")
                            ? config.imageModel.slice(0, config.imageModel.indexOf("::"))
                            : config.channels?.[0]?.id || "default";
                        config = { ...config, imageModel: encodeChannelModel(prefix, "tt-image-2") };
                    }
                }
                return { ...state, config };
            },
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const persistedChannels = Array.isArray(persistedConfig.channels) ? persistedConfig.channels : [];
                const config = {
                    ...defaultConfig,
                    ...persistedConfig,
                    imgbedUrl: normalizeImgbedUrl(persistedConfig.imgbedUrl),
                    baseUrl: normalizeBaseUrl(persistedConfig.baseUrl || defaultConfig.baseUrl),
                    channels: persistedChannels.map((channel) => ({ ...channel, baseUrl: normalizeBaseUrl(channel.baseUrl) })),
                };
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || defaultConfig.imageModel, channels) || defaultConfig.imageModel,
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        reasoningEffort: config.reasoningEffort || "auto",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        videoMode: config.videoMode === "reference" ? "reference" : "frames",
                        canvasImageCount: config.canvasImageCount || "1",
                        proxyEnabled: Boolean(config.proxyEnabled),
                        proxyUrl: config.proxyUrl || DEFAULT_LOCAL_PROXY_URL,
                    },
                };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        result.push({ name, capability, script });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        return stripTrailingApiVersion(normalizeImportedBaseUrl(baseUrl));
    } catch {
        return stripTrailingApiVersion(baseUrl.trim().replace(/\/+$/, ""));
    }
}

/** Returns true if two baseUrls point to the same host/path (ignores trailing /v1). */
export function normalizedBaseUrlMatch(a: string, b: string) {
    if (!a || !b) return false;
    return normalizedBaseUrlKey(a) === normalizedBaseUrlKey(b);
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function stripTrailingApiVersion(baseUrl: string) {
    return baseUrl.replace(/\/v1$/i, "");
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    // 如果能力表里有友好名称（如 "Seedance 2.5"），优先显示。
    const cap = videoModelCapability(decoded.model);
    // 目录里的 display_name 也是运营维护的展示名；没有能力声明的模型（如某些图片模型）靠它兜底。
    let displayName = cap?.label || catalogVariant(decoded.model)?.display_name || decoded.model;
    // 单看「竖屏特惠」不知道是哪款模型，所以只要卡片名和线路名不同就补上前缀。
    // 不管这张卡片有几个变体——只有一条线路的卡片同样需要（如 Seedance 2.0 Mini）。
    const group = catalogGroupOf(decoded.model);
    if (group && group.display_name && !displayName.startsWith(group.display_name)) {
        displayName = `${group.display_name} · ${displayName}`;
    }
    if (!channel) return displayName;
    // 只有同名模型真的分布在多个渠道时才补渠道名做区分，单渠道时不显示冗余后缀。
    const sharedAcrossChannels = config.channels.filter((item) => item.models.some((model) => model.name === decoded.model)).length;
    return sharedAcrossChannels > 1 ? `${displayName}（${channel.name}）` : displayName;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        // 服务端目录模型（如 tt-image-2 / banana-pro / qr-v007 等）未必登记在本地 channel.models；
        // 只要渠道存在就保留原值，避免页面刷新后在 merge 阶段被清空并退回列表首项（纳米香蕉 2.1）。
        return channel ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return withLocalProxy(`${apiBaseUrl}${path}`);
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS. */
export function withLocalProxy(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    if (!proxyEnabled || !/^https?:\/\//i.test(url)) return url;
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base || url.startsWith(`${base}/`)) return url;
    return `${base}/${url}`;
}
