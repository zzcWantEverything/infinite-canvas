import axios from "axios";

import i18n from "@/i18n";
import { ApiError, signalUnauthorized } from "./http";

export type NewApiUser = {
    id: number;
    username: string;
    display_name: string;
    email: string;
    quota: number;
    used_quota: number;
    request_count: number;
    role: number;
    aff_quota: number;
    aff_history_quota: number;
    aff_count: number;
    aff_code: string;
};

export type LoginResult = {
    token: string;
    baseUrl: string;
    user: NewApiUser;
    /** access token 过期时间（unix 秒） */
    accessExpiresAt?: number;
};

export type RefreshResult = {
    accessToken: string;
    accessExpiresAt?: number;
    user?: NewApiUser;
};

export type SystemStatus = {
    register_enabled?: boolean;
    password_register_enabled?: boolean;
    email_verification?: boolean;
    turnstile_check?: boolean;
    turnstile_site_key?: string;
};

function authApiUrl(baseUrl: string, path: string) {
    // 开发环境走 vite proxy，生产环境走同域 nginx 反向代理，baseUrl 传空即可
    if (!baseUrl) return path;
    return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function extractTokenAndUser(data: Record<string, unknown>, baseUrl: string): LoginResult {
    const inner = (data.data ?? {}) as Record<string, unknown>;
    const token =
        (inner.access_token as string | undefined) ||
        (inner.token as string | undefined) ||
        "";
    if (!token) throw new Error((data.message as string) || "登录失败");
    const user = inner.user as NewApiUser | undefined;
    if (!user) throw new Error("无法获取用户信息");
    return { token, baseUrl, user, accessExpiresAt: readExpiresAt(inner.access_expires_at) };
}

function readExpiresAt(value: unknown): number | undefined {
    const seconds = typeof value === "number" ? value : Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * 用 HttpOnly 的 refresh cookie 换一张新的 access token。
 * new-api 的 access token 只有 15 分钟，refresh cookie 走 `Path=/api/user/auth`，
 * 同源请求会自动携带，因此这里不需要任何凭据参数。
 */
export async function refreshLoginSession(baseUrl: string): Promise<RefreshResult> {
    const res = await axios.post<{ success: boolean; message?: string; data?: Record<string, unknown> | null }>(
        authApiUrl(baseUrl, "/api/user/auth/refresh"),
        {},
    );
    const inner = (res.data.data ?? {}) as Record<string, unknown>;
    const accessToken = (inner.access_token as string | undefined) || "";
    if (!res.data.success || !accessToken) throw new ApiError(res.data.message || "登录已过期", "auth", 401);
    return {
        accessToken,
        accessExpiresAt: readExpiresAt(inner.access_expires_at),
        user: inner.user as NewApiUser | undefined,
    };
}

export async function fetchStatus(baseUrl: string): Promise<SystemStatus> {
    const res = await axios.get<{ success: boolean; data: SystemStatus }>(
        authApiUrl(baseUrl, "/api/status"),
    );
    return (res.data.data ?? res.data) as SystemStatus;
}

export async function sendVerificationCode(baseUrl: string, email: string, turnstile?: string): Promise<void> {
    const res = await axios.get<{ success: boolean; message?: string }>(
        authApiUrl(baseUrl, "/api/verification"),
        { params: turnstile ? { email, turnstile } : { email } },
    );
    if (!res.data.success) throw new Error(res.data.message || "发送失败");
}

export async function loginWithPassword(baseUrl: string, username: string, password: string, turnstile?: string): Promise<LoginResult> {
    const res = await axios.post<Record<string, unknown>>(
        authApiUrl(baseUrl, "/api/user/login"),
        { username, password },
        turnstile ? { params: { turnstile } } : undefined,
    );
    if (!res.data.success) throw new Error((res.data.message as string) || "登录失败");
    return extractTokenAndUser(res.data, baseUrl);
}

export async function registerUser(
    baseUrl: string,
    params: { username: string; password: string; email?: string; verification_code?: string; turnstile?: string },
): Promise<void> {
    const res = await axios.post<{ success: boolean; message?: string }>(
        authApiUrl(baseUrl, "/api/user/register"),
        { username: params.username, password: params.password, password2: params.password, email: params.email, verification_code: params.verification_code },
        params.turnstile ? { params: { turnstile: params.turnstile } } : undefined,
    );
    if (!res.data.success) throw new Error(res.data.message || "注册失败");
}

export async function fetchCurrentUser(baseUrl: string, token: string): Promise<NewApiUser> {
    const res = await axios.get<{ success: boolean; message: string; data: NewApiUser | null }>(
        authApiUrl(baseUrl, "/api/user/self"),
        { headers: { Authorization: `Bearer ${token}` }, requiresAuth: true },
    );
    const data = res.data;
    // 兼容后端用 200 + success:false 表达“未登录”的情况，统一按登录过期处理。
    if (!data.success || !data.data) {
        signalUnauthorized();
        throw new ApiError(data.message || i18n.t("apiErrors.sessionExpired"), "auth", 401);
    }
    return data.data;
}

// ── API Key 管理 ──────────────────────────────────────────

export type UserToken = { id: number; key: string; name?: string; status?: number };

/**
 * new-api 的 `/api/token/` 列表接口把 key 打码成 `abcd**********wxyz`（模型层 MaskTokenKey），
 * 这里的 key 只能用于展示，**绝不能当作凭据**。真正的完整 key 要再调 `/api/token/{id}/key`。
 */
export async function fetchUserTokens(baseUrl: string, token: string): Promise<UserToken[]> {
    const res = await axios.get<{ success: boolean; data?: { items?: UserToken[] } | UserToken[] | null }>(
        authApiUrl(baseUrl, "/api/token/"),
        { headers: { Authorization: `Bearer ${token}` }, requiresAuth: true },
    );
    const data = res.data.data;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray((data as { items?: unknown[] }).items)) return (data as { items: UserToken[] }).items;
    return [];
}

/** 取令牌的完整明文 key（`POST /api/token/{id}/key`），失败返回空串。 */
export async function fetchTokenFullKey(baseUrl: string, token: string, tokenId: number): Promise<string> {
    try {
        const res = await axios.post<{ success: boolean; message?: string; data?: { key?: string } | null }>(
            authApiUrl(baseUrl, `/api/token/${tokenId}/key`),
            {},
            { headers: { Authorization: `Bearer ${token}` }, requiresAuth: true },
        );
        return res.data.data?.key ?? "";
    } catch {
        return "";
    }
}

/** 真正能用来调用 `/v1/*`、`/api/qora-assets` 的凭据才算可用。 */
export function isUsableRelayKey(key: string | undefined | null): boolean {
    const value = (key || "").trim();
    if (!value) return false;
    // 打码后的 key 中间带 *，登录后的 access token 是 JWT（eyJ 开头），两者都认证不了。
    if (value.includes("*")) return false;
    if (value.startsWith("eyJ")) return false;
    return true;
}

/** 当前用户分组的全部可用模型名（图片/视频/文本都在里面，由调用方按能力过滤）。 */
export async function fetchUserModels(baseUrl: string, token: string): Promise<string[]> {
    const res = await axios.get<{ success: boolean; data?: string[] | null }>(
        authApiUrl(baseUrl, "/api/user/models"),
        { headers: { Authorization: `Bearer ${token}` }, requiresAuth: true },
    );
    return res.data.data ?? [];
}

/**
 * 新建一个「默认」无限额度令牌。
 * 注意：new-api 的 `POST /api/token/` 只返回 `{success, message}`，**不含 key**，
 * 所以这里不返回 key，创建后需要重新列一遍拿 id，再走 `/api/token/{id}/key` 取明文。
 */
export async function createDefaultApiKey(baseUrl: string, token: string): Promise<void> {
    const res = await axios.post<{ success: boolean; message?: string }>(
        authApiUrl(baseUrl, "/api/token/"),
        {
            name: "默认",
            remain_quota: 0,
            expired_time: -1,
            unlimited_quota: true,
            model_limits_enabled: false,
            model_limits: "",
            allow_ips: "",
            allow_user_quota_query: true,
            group: "default",
            auto_groups: [],
            cross_group_retry: false,
        },
        { headers: { Authorization: `Bearer ${token}` }, requiresAuth: true },
    );
    if (!res.data.success) throw new Error(res.data.message || "创建 API Key 失败");
}

/**
 * 用登录态换一个「可以真正发请求」的中转 key。
 * 依次尝试：已有令牌（优先启用的）→ 取其明文；都没有就新建一个再取明文。
 * 全部失败返回空串，调用方必须自行处理，**不能退回用登录 access token 顶替**。
 */
export async function resolveRelayApiKey(baseUrl: string, token: string): Promise<string> {
    const pick = (list: UserToken[]) => list.find((item) => item.id && item.status !== 2) || list.find((item) => item.id);

    const existing = pick(await fetchUserTokens(baseUrl, token).catch(() => []));
    if (existing) {
        const full = await fetchTokenFullKey(baseUrl, token, existing.id);
        if (isUsableRelayKey(full)) return full;
    }

    try {
        await createDefaultApiKey(baseUrl, token);
    } catch {
        return "";
    }
    const created = pick(await fetchUserTokens(baseUrl, token).catch(() => []));
    if (!created) return "";
    const full = await fetchTokenFullKey(baseUrl, token, created.id);
    return isUsableRelayKey(full) ? full : "";
}


function walletHeaders(token: string) {
    return { Authorization: `Bearer ${token}` };
}

export async function redeemCode(baseUrl: string, token: string, key: string): Promise<number> {
    const res = await axios.post<{ success: boolean; message?: string; data?: number }>(
        authApiUrl(baseUrl, "/api/user/topup"),
        { key },
        { headers: walletHeaders(token), requiresAuth: true },
    );
    if (!res.data.success) throw new Error(res.data.message || "兑换失败");
    return res.data.data ?? 0;
}

export async function fetchAffCode(baseUrl: string, token: string): Promise<string> {
    const res = await axios.get<{ success: boolean; data?: string }>(
        authApiUrl(baseUrl, "/api/user/aff"),
        { headers: walletHeaders(token), requiresAuth: true },
    );
    return res.data.data ?? "";
}
