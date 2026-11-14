// 模型目录（GET /api/user/models/catalog）的共享读取。
//
// 能力数据以前在前端 `config/video-models.ts` 里手写一份，后端插件里又写一份，两边已经漂移
// （例如分辨率写 "480" 还是 "480p"、时长区间写法不同）。现在唯一来源是网关：
// 后端按插件声明 + models.capabilities 解析好，前端只负责渲染它声明过的能力。
//
// 取数用登录态（与 /api/user/models 一样走 UserAuth），不是渠道 apiKey。
// 失败一律静默：内置能力表仍然是兜底，目录拉不到不能让界面报错。
import axios from "axios";

// 需要 http.ts 的拦截器：它负责 401 时静默续期并重放，只靠本地 axios 拿不到这个行为。
import "./http";

/** 本地化文案；后端 `jsplugin.LocalizedText` 的线上形状。 */
export type CatalogLocalizedText = { en?: string; zh?: string };

/**
 * 能力字段描述。视频与图片共用同一套形状，所以键名不固定：
 * 视频是 resolution / ratio / seconds / max_images，图片是 size / quality / n。
 */
export type CatalogCapabilityField = {
    type?: string;
    unit?: string;
    unitLabel?: CatalogLocalizedText;
    description?: CatalogLocalizedText;
    enum?: string[];
    enumLabels?: Record<string, CatalogLocalizedText>;
    min?: number;
    max?: number;
    step?: number;
    default?: string | number;
    /** `limit` 表示上限约束，不是用户输入项。 */
    role?: string;
    order?: number;
};

export type CatalogCapability = {
    protocol?: string;
    invocation: string;
    billingUnit: string;
    modality?: { input?: string[]; output?: string[] };
    fields: Record<string, CatalogCapabilityField>;
};

export type CatalogPricing = {
    mode: string;
    unit?: string;
    examples?: Array<{ label: string; facts: Record<string, unknown> }>;
};

export type CatalogVariant = {
    model: string;
    display_name: string;
    capabilities?: CatalogCapability;
    pricing: CatalogPricing;
};

export type CatalogGroup = {
    model: string;
    display_name: string;
    icon?: string;
    description?: string;
    tags?: string[];
    endpoints?: string[];
    variants: CatalogVariant[];
};

type CatalogPayload = { success?: boolean; data?: CatalogGroup[] | null; message?: string };

const CACHE_TTL = 5 * 60 * 1000;

let variantIndex: Map<string, CatalogVariant> | null = null;
let groupIndex: Map<string, CatalogGroup> | null = null;
let cachedAt = 0;
let cachedScope = "";
let inflight: Promise<CatalogVariant[]> | null = null;

// 目录是模块级缓存，拉到之后要让正在渲染的面板重算一次能力，否则会一直停在兜底数据上。
let version = 0;
const listeners = new Set<() => void>();

function notify() {
    version += 1;
    for (const listener of listeners) listener();
}

export function subscribeModelCatalog(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function modelCatalogVersion() {
    return version;
}

function catalogUrl(baseUrl: string) {
    const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
    // 开发环境走 vite proxy、生产走同源 nginx 反代，baseUrl 空即可；与 authApiUrl 保持一致。
    return trimmed ? `${trimmed}/api/user/models/catalog` : "/api/user/models/catalog";
}

function indexCatalog(groups: CatalogGroup[]) {
    const variants: CatalogVariant[] = [];
    const groupOfModel = new Map<string, CatalogGroup>();
    for (const group of groups) {
        if (!group || !Array.isArray(group.variants)) continue;
        for (const variant of group.variants) {
            if (!variant || typeof variant.model !== "string" || !variant.model) continue;
            variants.push({ ...variant, display_name: variant.display_name || group.display_name || variant.model });
            groupOfModel.set(variant.model, group);
        }
    }
    return { variants, groupOfModel };
}

async function requestCatalog(baseUrl: string, token: string) {
    const response = await axios.get<CatalogPayload>(catalogUrl(baseUrl), {
        headers: { Authorization: `Bearer ${token}` },
        requiresAuth: true,
    });
    if (!response.data?.success) throw new Error(response.data?.message || "model catalog unavailable");
    return indexCatalog(Array.isArray(response.data.data) ? response.data.data : []);
}

/**
 * 拉取并缓存模型目录。同一个账号只发一轮请求；失败的 Promise 会吞掉错误，
 * 调用方不需要 catch，下次挂载会重试。
 */
export function fetchModelCatalog(baseUrl: string, token: string, options?: { force?: boolean }): Promise<CatalogVariant[]> {
    const scope = `${(baseUrl || "").trim()}|${(token || "").trim()}`;
    if (!token) return Promise.resolve(variantIndex ? Array.from(variantIndex.values()) : []);
    if (!options?.force && variantIndex && scope === cachedScope && Date.now() - cachedAt < CACHE_TTL) {
        return Promise.resolve(Array.from(variantIndex.values()));
    }
    if (inflight) return inflight;

    const task = (async () => {
        try {
            const indexed = await requestCatalog(baseUrl, token);
            variantIndex = new Map(indexed.variants.map((variant) => [variant.model, variant]));
            groupIndex = indexed.groupOfModel;
            cachedAt = Date.now();
            cachedScope = scope;
            notify();
            return indexed.variants;
        } catch {
            // 目录拉不到时保留上一次的缓存（若有），没有就让内置能力表兜底。
            return variantIndex ? Array.from(variantIndex.values()) : [];
        }
    })();

    inflight = task.finally(() => {
        inflight = null;
    });
    return inflight;
}

/** 同步读取缓存里的变体；目录还没拉到时返回 null，调用方回退到内置表。 */
export function catalogVariant(model: string): CatalogVariant | null {
    if (!variantIndex) return null;
    return variantIndex.get(model) ?? null;
}

/**
 * 该模型所属的展示卡片。没有 variant_group 的模型也会有一张自己的单变体卡片，
 * 所以这里返回的组只有在 variants 多于一个时才值得做分组展示。
 */
export function catalogGroupOf(model: string): CatalogGroup | null {
    if (!groupIndex) return null;
    return groupIndex.get(model) ?? null;
}

/** 切换账号或后台改了模型配置后需要重取。 */
export function invalidateModelCatalogCache() {
    variantIndex = null;
    groupIndex = null;
    cachedAt = 0;
    cachedScope = "";
    inflight = null;
    notify();
}
