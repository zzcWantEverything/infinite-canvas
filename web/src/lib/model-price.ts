// 从 /api/pricing 的计费表达式算出「本次请求要花多少钱」。
//
// 后端任务类模型的扣费口径（pkg/billingexpr/expr.md）：
//   quota = 表达式返回值（元）× QuotaPerUnit × 分组倍率
// 所以这里返回的 cost 是**乘倍率之前**的金额，调用方还要再乘 group_ratio。
//
// 表达式是运营在后台随手写的，可能引用任何 schema 里的字段。这里只提供视频面板
// 真实知道的用量（秒数、分辨率、token 估算值），表达式引用了别的字段时求值会失败，
// 由调用方回退到内置价格表，而不是猜一个默认值。
import { evaluateBillingExpression } from "@/lib/billing-expression/runtime";
import type { PricingModelEntry } from "@/services/api/pricing";

export type ModelPriceFacts = {
    seconds: number;
    /** 画柚内部的档位写法（"480" / "720" / "1080"），与后端的 "480p" 不同。 */
    resolution: string;
    /** 按 token 计费的上游（Ark）用得到；不传就不提供这个用量。 */
    tokens?: number;
    /** 目录 `pricing.examples` 里给的示例用量（图片模型按 p / cr / img / c 计费），直接并进表达式变量。 */
    extra?: Record<string, number>;
};

/**
 * 把画柚的档位写法对齐到表达式 schema 的枚举值。
 * 枚举里既没有 "720" 也没有 "720p" 时返回 undefined——宁可让求值失败回退，
 * 也不要拿一个不存在的档位去走错分支。
 */
function resolutionForSchema(entry: PricingModelEntry, resolution: string): string | undefined {
    const values = entry.usageSchema?.resolution?.enum;
    const candidates = [resolution, `${resolution}p`];
    if (!Array.isArray(values) || !values.length) return `${resolution}p`;
    return candidates.find((candidate) => values.includes(candidate));
}

/**
 * 算出该模型本次请求的金额（元，未乘分组倍率）。
 * 返回 null 表示「这份表达式算不出来」，调用方应回退到内置价格表。
 */
export function estimateModelPrice(entry: PricingModelEntry | null | undefined, facts: ModelPriceFacts): number | null {
    if (!entry) return null;
    // 按次计费的模型没有表达式，model_price 就是单价。
    if (entry.modelPrice > 0) return entry.modelPrice;
    if (entry.billingMode !== "tiered_expr" || !entry.billingExpr) return null;

    const usage: Record<string, unknown> = {};
    if (Number.isFinite(facts.seconds) && facts.seconds > 0) usage.seconds = facts.seconds;
    const resolution = resolutionForSchema(entry, facts.resolution);
    if (resolution) usage.resolution = resolution;
    if (typeof facts.tokens === "number" && Number.isFinite(facts.tokens) && facts.tokens > 0) usage.tokens = facts.tokens;
    if (facts.extra) for (const [key, value] of Object.entries(facts.extra)) if (Number.isFinite(value)) usage[key] = value;

    const result = evaluateBillingExpression(entry.billingExpr, { usage });
    if (result.status !== "success" || !Number.isFinite(result.cost) || result.cost < 0) return null;
    // runtime 返回的就是元：线上表达式都是 tier("base", 3.82) / tier("base", u("seconds") * 0.65)。
    // 只有 fixed(n) 在 runtime 内部会乘 1e6，而线上没有任何模型用 fixed ——
    // 曾为「修正 fixed」统一除过 1e6，结果所有模型价格变成 ¥0，别再这么干。
    return result.cost;
}
