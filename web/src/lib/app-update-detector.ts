/**
 * 纯函数工具：为前端构建资源（JS/CSS 入口指纹）与后端模型价目表/目录生成规范化指纹，
 * 避免 Go map 随机遍历顺序或网络抖动导致的误报。
 */

export function canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : canonicalStringify(item))).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
        .filter((key) => obj[key] !== undefined)
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`).join(",")}}`;
}

export function fingerprintText(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x050c5d1f;
    for (let i = 0; i < input.length; i += 1) {
        const c = input.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193);
        h2 ^= c + ((i + 1) & 0xff);
        h2 = Math.imul(h2, 0x01000193);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

const ENTRY_ASSET_RE = /\/?(assets\/index-[^"'?\s<>\\]+\.(?:js|css))/g;

export function extractHtmlBuildFingerprint(html: string): string {
    if (!html || typeof html !== "string") return "";
    const assets = new Set<string>();
    for (const match of html.matchAll(ENTRY_ASSET_RE)) {
        if (match[1]) assets.add(`/${match[1]}`);
    }
    if (!assets.size) return "";
    return Array.from(assets).sort().join("|");
}

function normalizeAssetPathname(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            return new URL(trimmed).pathname;
        } catch {
            return trimmed.split("?")[0].split("#")[0];
        }
    }
    return trimmed.split("?")[0].split("#")[0];
}

export function readDocumentBuildFingerprint(doc?: Document): string {
    const target = doc ?? (typeof document !== "undefined" ? document : undefined);
    if (!target) return "";
    const assets = new Set<string>();
    const elements = target.querySelectorAll('script[src], link[rel="stylesheet"][href]');
    for (const element of elements) {
        const raw = element.getAttribute("src") || element.getAttribute("href") || "";
        const path = normalizeAssetPathname(raw);
        const match = path.match(/^\/?(assets\/index-[^"'?\s<>\\]+\.(?:js|css))$/);
        if (match?.[1]) assets.add(`/${match[1]}`);
    }
    if (!assets.size) return "";
    return Array.from(assets).sort().join("|");
}

export function buildPricingFingerprint(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as { success?: unknown; data?: unknown; group_ratio?: unknown };
    if (record.success !== true || !Array.isArray(record.data)) return "";

    const rawGroupRatio = record.group_ratio && typeof record.group_ratio === "object" ? (record.group_ratio as Record<string, unknown>) : {};
    const groupRatio: Record<string, unknown> = {};
    for (const key of Object.keys(rawGroupRatio).sort()) {
        groupRatio[key] = rawGroupRatio[key];
    }

    const models = (record.data as Array<Record<string, unknown>>)
        .map((item) => {
            const modelName = typeof item?.model_name === "string" ? item.model_name : "";
            if (!modelName) return null;
            const enableGroups = Array.isArray(item.enable_groups)
                ? [...item.enable_groups.filter((g): g is string => typeof g === "string")].sort()
                : [];
            return {
                model_name: modelName,
                model_price: typeof item.model_price === "number" && Number.isFinite(item.model_price) ? item.model_price : 0,
                model_ratio: typeof item.model_ratio === "number" && Number.isFinite(item.model_ratio) ? item.model_ratio : 0,
                completion_ratio: typeof item.completion_ratio === "number" && Number.isFinite(item.completion_ratio) ? item.completion_ratio : 0,
                billing_mode: typeof item.billing_mode === "string" ? item.billing_mode : "",
                billing_expr: typeof item.billing_expr === "string" ? item.billing_expr : "",
                billing_usage_schema: item.billing_usage_schema ?? null,
                enable_groups: enableGroups,
            };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => a.model_name.localeCompare(b.model_name));

    return fingerprintText(canonicalStringify({ group_ratio: groupRatio, data: models }));
}

export function buildCatalogFingerprint(payload: unknown): string {
    let rawGroups: unknown[] | null = null;
    if (Array.isArray(payload)) {
        rawGroups = payload;
    } else if (payload && typeof payload === "object") {
        const record = payload as { success?: unknown; data?: unknown };
        if (record.success === true && Array.isArray(record.data)) rawGroups = record.data;
    }
    if (!rawGroups) return "";

    const groups = (rawGroups as Array<Record<string, unknown>>)
        .map((group) => {
            const model = typeof group?.model === "string" ? group.model : "";
            if (!model) return null;
            const tags = Array.isArray(group.tags) ? [...group.tags.filter((x): x is string => typeof x === "string")].sort() : [];
            const endpoints = Array.isArray(group.endpoints) ? [...group.endpoints.filter((x): x is string => typeof x === "string")].sort() : [];
            const variants = Array.isArray(group.variants)
                ? (group.variants as Array<Record<string, unknown>>)
                      .map((variant) => {
                          const variantModel = typeof variant?.model === "string" ? variant.model : "";
                          if (!variantModel) return null;
                          return {
                              model: variantModel,
                              display_name: typeof variant.display_name === "string" ? variant.display_name : "",
                              capabilities: variant.capabilities ?? null,
                              pricing: variant.pricing ?? null,
                          };
                      })
                      .filter((v): v is NonNullable<typeof v> => Boolean(v))
                      .sort((a, b) => a.model.localeCompare(b.model))
                : [];
            return {
                model,
                display_name: typeof group.display_name === "string" ? group.display_name : "",
                icon: typeof group.icon === "string" ? group.icon : "",
                description: typeof group.description === "string" ? group.description : "",
                tags,
                endpoints,
                variants,
            };
        })
        .filter((g): g is NonNullable<typeof g> => Boolean(g))
        .sort((a, b) => a.model.localeCompare(b.model));

    return fingerprintText(canonicalStringify(groups));
}

export function shouldTriggerUpdate(baseline: string, next: string): boolean {
    return Boolean(baseline && next && baseline !== next);
}
