import i18n from "@/i18n";
import { useUserStore } from "@/stores/use-user-store";
import { notifyApiError, setUnauthorizedHandler } from "./http";

// 登录态失效：清空会话，AuthGuard 会自动把用户带回登录页。
setUnauthorizedHandler(() => {
    const { session, clearSession } = useUserStore.getState();
    if (!session) return;
    clearSession();
    notifyApiError(i18n.t("apiErrors.sessionExpired"));
});

/** 启动时校验一次登录态，避免过期 token 一直显示为已登录、请求却全部失败。 */
export async function validateSession() {
    if (!useUserStore.getState().session) return;
    try {
        await useUserStore.getState().refreshUser();
    } catch {
        // 401 已由 http 层统一处理；离线或网络异常不踢人，保持当前会话。
    }
}
