// 余额 / 消费金额的换算与展示。
//
// new-api 的额度单位是整数 quota，结算口径 500000 quota = 1 元（见 lib/model-price.ts
// 与后端 pkg/billingexpr）。全站金额都从这里出，避免出现「顶栏取整到元、钱包页保留两位小数」
// 这种同一个余额显示成两个数字的情况。

const QUOTA_PER_UNIT = 500000;

/** 额度 → 元（数值），需要参与计算或拼文案时用。 */
export function quotaToYuan(quota: number | null | undefined): number {
    return (quota ?? 0) / QUOTA_PER_UNIT;
}

/** 额度 → 「¥12.34」。金额展示统一走这里。 */
export function formatQuotaYuan(quota: number | null | undefined): string {
    return `¥${quotaToYuan(quota).toFixed(2)}`;
}

/** 元 → 额度。解析后端日志文案里的金额时用。 */
export function yuanToQuota(yuan: number | null | undefined): number {
    return Math.round((yuan ?? 0) * QUOTA_PER_UNIT);
}
