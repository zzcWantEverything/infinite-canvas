// /api/pricing 的共享读取：分组倍率 + 每个模型的计费表达式。
//
// 后端的实际扣费是 `表达式结果 × 分组倍率`（relay/helper/price.go: modelPrice * QuotaPerUnit * GroupRatio，
// 任务类模型是 relay/relay_task.go 里的 cost * QuotaPerUnit * GroupRatio），
// 所以前端预估价格必须用同一份表达式、乘同一个倍率，否则显示值和真实扣费会脱钩。
//
// 这里的取数刻意不依赖 AiConfig.apiKey：/api/pricing 在 header nav 里默认是「免登录」的公开接口，
// 只要同源请求就能拿到结果。此前的实现把 apiKey 当成硬前置条件，一旦某个面板拿到的 config 没有
// 填 apiKey 就直接 return，倍率永远是 1（表现为价格恰好等于单价，肉眼看不出来）。
import { withLocalProxy } from "@/stores/use-config-store";

export type PricingRatioSnapshot = {
    /** 当前用户所在分组的倍率。 */
    ratio: number;
    /** 该倍率对应的分组名，仅用于说明来源。 */
    group: string;
};

/** 计费表达式引用的一个用量字段（后端 `jsplugin.UsageFieldSchema` 的线上形状）。 */
export type PricingUsageField = {
    type?: string;
    unit?: string;
    enum?: string[];
};

/** /api/pricing → data[] 里与“算钱”有关的部分。 */
export type PricingModelEntry = {
    model: string;
    /** `tiered_expr` 走表达式，其余走 model_price / model_ratio。 */
    billingMode: string;
    billingExpr: string;
    /** 按次价格；0 表示这个模型不按次计费。 */
    modelPrice: number;
    usageSchema: Record<string, PricingUsageField>;
};

export type PricingSnapshot = PricingRatioSnapshot & {
    models: Map<string, PricingModelEntry>;
};

type RawPricingModel = {
    model_name?: unknown;
    model_price?: unknown;
    billing_mode?: unknown;
    billing_expr?: unknown;
    billing_usage_schema?: unknown;
};

type RawPricingPayload = {
    success?: boolean;
    data?: unknown;
    group_ratio?: Record<string, unknown>;
    usable_group?: Record<string, unknown>;
    auto_groups?: unknown;
};

const CACHE_TTL = 5 * 60 * 1000;

let cachedSnapshot: PricingSnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<PricingSnapshot | null> | null = null;

/**
 * 候选地址：同源相对路径优先。
 *
 * 画柚自己的会话类接口（/api/user/models、/api/user/auth/refresh）本来就走同源相对路径，
 * 说明部署上 `/api/` 一定被转发到网关；用相对路径还能顺带带上登录 cookie，
 * 让 GetPricing 拿到真实用户分组。绝对地址只作为反向代理没配 /api 时的兜底。
 */
export function pricingCandidates(baseUrl: string) {
    const candidates = ["/api/pricing"];
    const rawBase = (baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (/^https?:\/\//i.test(rawBase)) {
        // 去掉端口：网关常常只在内网端口上监听，公网回落到 80/443 的同源 /api。
        candidates.push(`${rawBase.replace(/:\d+$/, "")}/api/pricing`);
        candidates.push(`${rawBase}/api/pricing`);
    }
    return Array.from(new Set(candidates));
}

/** group_ratio 的键是分组名；优先认 auto_groups（当前用户的实际分组），再退回 usable_group / default。 */
export function pickGroupRatio(payload: RawPricingPayload | null | undefined): PricingRatioSnapshot | null {
    const ratios = payload?.group_ratio;
    if (!ratios || typeof ratios !== "object") return null;
    const autoGroups = Array.isArray(payload?.auto_groups) ? payload.auto_groups.filter((item): item is string => typeof item === "string") : [];
    const usableGroups = payload?.usable_group && typeof payload.usable_group === "object" ? Object.keys(payload.usable_group) : [];
    const candidates = [...autoGroups, ...usableGroups, "default", ...Object.keys(ratios)];
    for (const group of candidates) {
        const value = ratios[group];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return { ratio: value, group };
    }
    return null;
}

/** 把 /api/pricing 的 data[] 索引成「模型名 → 计费规则」，模型没配表达式时也会留一条按次价格记录。 */
export function buildPricingModels(payload: RawPricingPayload | null | undefined): Map<string, PricingModelEntry> {
    const models = new Map<string, PricingModelEntry>();
    const list = Array.isArray(payload?.data) ? payload.data : [];
    for (const raw of list as RawPricingModel[]) {
        const name = typeof raw?.model_name === "string" ? raw.model_name : "";
        if (!name) continue;
        models.set(name, {
            model: name,
            billingMode: typeof raw.billing_mode === "string" ? raw.billing_mode : "",
            billingExpr: typeof raw.billing_expr === "string" ? raw.billing_expr : "",
            modelPrice: typeof raw.model_price === "number" && Number.isFinite(raw.model_price) ? raw.model_price : 0,
            usageSchema: raw.billing_usage_schema && typeof raw.billing_usage_schema === "object" ? (raw.billing_usage_schema as Record<string, PricingUsageField>) : {},
        });
    }
    return models;
}

async function requestPricing(url: string, apiKey?: string) {
    const headers: Record<string, string> = { Accept: "application/json" };
    const trimmedKey = (apiKey || "").trim();
    if (trimmedKey) headers.Authorization = `Bearer ${trimmedKey}`;
    const response = await fetch(withLocalProxy(url), { headers, credentials: "include" });
    if (!response.ok) throw new Error(`pricing ${response.status}`);
    const payload = (await response.json()) as RawPricingPayload;
    if (!payload?.success) throw new Error("pricing unavailable");
    return payload;
}

/**
 * 读取分组倍率与整张模型价目表。失败返回 null（调用方按 1 兜底、价格回退内置表），
 * 且不缓存失败结果，下次挂载会重试。同一个 baseUrl 只发一轮请求，避免多个面板各拉一次。
 */
export function fetchPricingSnapshot(baseUrl: string, apiKey?: string): Promise<PricingSnapshot | null> {
    if (cachedSnapshot && Date.now() - cachedAt < CACHE_TTL) return Promise.resolve(cachedSnapshot);
    if (inflight) return inflight;

    const attempts: Array<{ url: string; apiKey?: string }> = [];
    for (const url of pricingCandidates(baseUrl)) {
        attempts.push({ url });
        // 带上 key 再试一次：多分组场景下只有鉴权后才能确定自己的分组。
        if ((apiKey || "").trim()) attempts.push({ url, apiKey });
    }

    const task = (async () => {
        for (const attempt of attempts) {
            try {
                const payload = await requestPricing(attempt.url, attempt.apiKey);
                const ratio = pickGroupRatio(payload);
                if (!ratio) continue;
                const snapshot: PricingSnapshot = { ...ratio, models: buildPricingModels(payload) };
                cachedSnapshot = snapshot;
                cachedAt = Date.now();
                return snapshot;
            } catch {
                // 换下一个候选地址/鉴权方式；全部失败时由调用方兜底为 1。
            }
        }
        return null;
    })();

    inflight = task.finally(() => {
        inflight = null;
    });
    return inflight;
}

/** 切换账号或后台改了倍率/价格后需要重取。 */
export function invalidatePricingCache() {
    cachedSnapshot = null;
    cachedAt = 0;
    inflight = null;
}
