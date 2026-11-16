import axios from "axios";

/**
 * new-api 的额度流水。全站只有 `/api/log/self` 这一份数据，type 区分收支方向：
 * 1 充值、2 消费、3 管理调整、4 系统、5 错误、6 退款、7 登录。
 * quota 恒为正数，符号由 type 决定（退款记 LogTypeRefund，不会写成负数）。
 */
export type UsageLogType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type UsageLog = {
    id: number;
    /** 秒级时间戳 */
    created_at: number;
    type: UsageLogType;
    content: string;
    model_name: string;
    /** 额度单位，500000 quota = ¥1 */
    quota: number;
    prompt_tokens: number;
    completion_tokens: number;
    token_name?: string;
    other?: string;
};

export type UsageLogPage = {
    items: UsageLog[];
    total: number;
    page: number;
    pageSize: number;
};

export const USAGE_LOG_PAGE_SIZE = 20;

export async function fetchUsageLogs(
    baseUrl: string,
    token: string,
    options: { type?: UsageLogType; page?: number; pageSize?: number } = {},
): Promise<UsageLogPage> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? USAGE_LOG_PAGE_SIZE;
    const url = `${(baseUrl || "").trim().replace(/\/+$/, "")}/api/log/self`;
    const res = await axios.get<{
        success: boolean;
        message?: string;
        data?: { items?: UsageLog[] | null; total?: number; page?: number; page_size?: number } | null;
    }>(url, {
        params: { p: page, page_size: pageSize, ...(options.type ? { type: options.type } : {}) },
        headers: { Authorization: `Bearer ${token}` },
        requiresAuth: true,
    });
    const data = res.data;
    if (!data.success || !data.data) throw new Error(data.message || "获取余额明细失败");
    return {
        items: data.data.items ?? [],
        total: data.data.total ?? 0,
        page: data.data.page ?? page,
        pageSize: data.data.page_size ?? pageSize,
    };
}
