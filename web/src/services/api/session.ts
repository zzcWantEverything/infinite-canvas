import i18n from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore, type UserSession } from "@/stores/use-user-store";
import { isUsableRelayKey, refreshLoginSession, resolveRelayApiKey } from "./auth";
import { ApiError, notifyApiError, setAuthTokenHooks, setUnauthorizedHandler } from "./http";

/** access token 剩余不到这个时长就提前续期，避免请求打到一半失效。 */
const REFRESH_SKEW_MS = 60 * 1000;

// 登录态失效：清空会话，AuthGuard 会自动把用户带回登录页。
setUnauthorizedHandler(() => {
    const { session, clearSession } = useUserStore.getState();
    if (!session) return;
    clearSession();
    notifyApiError(i18n.t("apiErrors.sessionExpired"));
});

function expiresAtMs(session: UserSession | null) {
    return session?.accessExpiresAt ? session.accessExpiresAt * 1000 : 0;
}

/** 当前登录态是否该续期了。没有过期时间的老会话返回 true，续一次即可补上。 */
export function sessionNeedsRefresh() {
    const { session } = useUserStore.getState();
    if (!session?.token) return false;
    const at = expiresAtMs(session);
    if (!at) return true;
    return Date.now() >= at - REFRESH_SKEW_MS;
}

async function performRefresh(): Promise<string | null> {
    const { session, setSession, clearSession } = useUserStore.getState();
    if (!session?.baseUrl) return null;
    try {
        const result = await refreshLoginSession(session.baseUrl);
        setSession({
            ...session,
            token: result.accessToken,
            accessExpiresAt: result.accessExpiresAt,
            user: result.user ?? session.user,
        });
        return result.accessToken;
    } catch (error) {
        // 只有服务端明确拒绝才算登录失效；网络异常保留会话，等下次再试。
        const rejected = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.kind === "auth");
        if (rejected) clearSession();
        return null;
    }
}

let refreshPromise: Promise<string | null> | null = null;

/**
 * 续期 access token（单飞）：并发调用共享同一次请求。
 * new-api 的 refresh token 会轮转，重复请求容易触发 replay 判定，所以必须收敛成一次。
 */
export function refreshAccessToken(): Promise<string | null> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
    });
    return refreshPromise;
}

// 交给请求层：注入 token、判断是否临近过期、按需续期。
setAuthTokenHooks({
    getToken: () => useUserStore.getState().session?.token ?? null,
    needsRefresh: sessionNeedsRefresh,
    refresh: refreshAccessToken,
});

/** 启动时校验一次登录态，避免过期 token 一直显示为已登录、请求却全部失败。 */
export async function validateSession() {
    if (!useUserStore.getState().session) return;
    // access token 只有 15 分钟，冷启动时基本已经过期 —— 先用 refresh cookie 换新的再校验。
    if (sessionNeedsRefresh()) {
        const token = await refreshAccessToken();
        if (!token) return;
    }
    try {
        await useUserStore.getState().refreshUser();
    } catch {
        // 401 已由 http 层统一处理；离线或网络异常不踢人，保持当前会话。
    }
}

function sameBaseUrl(a: string | undefined, b: string | undefined) {
    const normalize = (value: string | undefined) => (value || "").trim().replace(/\/+$/, "").toLowerCase();
    const normalized = normalize(a);
    return normalized !== "" && normalized === normalize(b);
}

/**
 * 修复历史脏凭据：早期登录流程会把「打码后的 key」（`abcd**********wxyz`）
 * 或「登录 access token」（`eyJ...`）写进渠道 apiKey，这两者都认证不了，
 * 表现出来就是 /api/qora-assets、/v1/* 全部 401。
 *
 * 启动时若发现当前 baseUrl 对应的渠道 key 不可用，就用登录态重新换一个明文 key 覆盖掉。
 */
export async function repairChannelCredentials() {
    const { session } = useUserStore.getState();
    if (!session?.token || !session.baseUrl) return;

    const { config, importChannelCredentials } = useConfigStore.getState();
    const broken = config.channels.filter((channel) => sameBaseUrl(channel.baseUrl, session.baseUrl) && !isUsableRelayKey(channel.apiKey));
    if (!broken.length) return;

    const apiKey = await resolveRelayApiKey(session.baseUrl, session.token);
    if (!apiKey) return;
    importChannelCredentials({ baseUrl: session.baseUrl, apiKey });
}
