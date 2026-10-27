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
};

export type LoginResult = {
    token: string;
    user: NewApiUser;
};

function authApiUrl(baseUrl: string, path: string) {
    return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

export async function loginWithPassword(baseUrl: string, username: string, password: string): Promise<LoginResult> {
    const res = await axios.post<{ success: boolean; message: string; data: { token?: string; user?: NewApiUser } | null }>(
        authApiUrl(baseUrl, "/api/user/login"),
        { username, password },
    );
    const data = res.data;
    if (!data.success || !data.data?.token) {
        throw new Error(data.message || "登录失败");
    }
    // new-api 的 token 存在 cookie，同时 data.data 里也有 token
    return { token: data.data.token, user: data.data.user! };
}

export async function registerUser(baseUrl: string, username: string, password: string): Promise<LoginResult> {
    const res = await axios.post<{ success: boolean; message: string; data: { token?: string; user?: NewApiUser } | null }>(
        authApiUrl(baseUrl, "/api/user/register"),
        { username, password, password2: password },
    );
    const data = res.data;
    if (!data.success || !data.data?.token) {
        throw new Error(data.message || "注册失败");
    }
    return { token: data.data.token, user: data.data.user! };
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
