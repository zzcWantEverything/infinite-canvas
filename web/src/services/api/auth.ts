import axios from "axios";

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
};

export type SystemStatus = {
    register_enabled?: boolean;
    password_register_enabled?: boolean;
    email_verification?: boolean;
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
    return { token, baseUrl, user };
}

export async function fetchStatus(baseUrl: string): Promise<SystemStatus> {
    const res = await axios.get<{ success: boolean; data: SystemStatus }>(
        authApiUrl(baseUrl, "/api/status"),
    );
    return (res.data.data ?? res.data) as SystemStatus;
}

export async function sendVerificationCode(baseUrl: string, email: string): Promise<void> {
    const res = await axios.get<{ success: boolean; message?: string }>(
        authApiUrl(baseUrl, "/api/verification"),
        { params: { email } },
    );
    if (!res.data.success) throw new Error(res.data.message || "发送失败");
}

export async function loginWithPassword(baseUrl: string, username: string, password: string): Promise<LoginResult> {
    const res = await axios.post<Record<string, unknown>>(
        authApiUrl(baseUrl, "/api/user/login"),
        { username, password },
    );
    if (!res.data.success) throw new Error((res.data.message as string) || "登录失败");
    return extractTokenAndUser(res.data, baseUrl);
}

export async function registerUser(
    baseUrl: string,
    params: { username: string; password: string; email?: string; verification_code?: string },
): Promise<void> {
    const res = await axios.post<{ success: boolean; message?: string }>(
        authApiUrl(baseUrl, "/api/user/register"),
        { username: params.username, password: params.password, password2: params.password, email: params.email, verification_code: params.verification_code },
    );
    if (!res.data.success) throw new Error(res.data.message || "注册失败");
}

export async function fetchCurrentUser(baseUrl: string, token: string): Promise<NewApiUser> {
    const res = await axios.get<{ success: boolean; message: string; data: NewApiUser | null }>(
        authApiUrl(baseUrl, "/api/user/self"),
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = res.data;
    if (!data.success || !data.data) {
        throw new Error(data.message || "获取用户信息失败");
    }
    return data.data;
}

// ── API Key 管理 ──────────────────────────────────────────

export async function fetchUserTokens(baseUrl: string, token: string): Promise<{ id: number; key: string }[]> {
    const res = await axios.get<{ success: boolean; data?: { id: number; key: string }[] | null }>(
        authApiUrl(baseUrl, "/api/token/"),
        { headers: { Authorization: `Bearer ${token}` } },
    );
    return res.data.data ?? [];
}

export async function createDefaultApiKey(baseUrl: string, token: string): Promise<string> {
    const res = await axios.post<{ success: boolean; message?: string; data?: { key?: string } | null }>(
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
        { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.data.success) throw new Error(res.data.message || "创建 API Key 失败");
    return res.data.data?.key ?? "";
}


function walletHeaders(token: string) {
    return { Authorization: `Bearer ${token}` };
}

export async function redeemCode(baseUrl: string, token: string, key: string): Promise<number> {
    const res = await axios.post<{ success: boolean; message?: string; data?: number }>(
        authApiUrl(baseUrl, "/api/user/topup"),
        { key },
        { headers: walletHeaders(token) },
    );
    if (!res.data.success) throw new Error(res.data.message || "兑换失败");
    return res.data.data ?? 0;
}

export async function fetchAffCode(baseUrl: string, token: string): Promise<string> {
    const res = await axios.get<{ success: boolean; data?: string }>(
        authApiUrl(baseUrl, "/api/user/aff"),
        { headers: walletHeaders(token) },
    );
    return res.data.data ?? "";
}
