import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { AppUpdateBanner } from "@/components/layout/app-update-banner";
import { setApiErrorNotifier } from "@/services/api/http";
import { repairChannelCredentials, validateSession } from "@/services/api/session";
import { switchCanvasSessionUser } from "@/services/canvas-cloud-sync";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const userHydrated = useUserStore((state) => state.hydrated);
    const currentUserId = useUserStore((state) => state.session?.user?.id ?? null);

    usePromptSourceScheduler();

    // 把 antd 的 message 交给请求层，非 React 的请求失败也能提示用户。
    useEffect(() => {
        setApiErrorNotifier((text) => {
            void message.error(text);
        });
    }, [message]);

    // 启动时校验一次登录态；token 过期会清空会话并回到登录页。
    useEffect(() => {
        void validateSession();
    }, []);

    // 登录态校验通过后，顺手修复历史遗留的脏渠道凭据（打码 key / 登录 token 当 key 用）。
    useEffect(() => {
        void repairChannelCredentials();
    }, []);

    // 会话加载/登录/切号/登出时，严格按 userId 切换本地画布与同步状态。
    useEffect(() => {
        if (!userHydrated) return;
        void switchCanvasSessionUser(currentUserId);
    }, [currentUserId, userHydrated]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const result = importChannelCredentials({ baseUrl, apiKey });
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [importChannelCredentials, message, t]);

    return (
        <>
            {children}
            <AppUpdateBanner />
        </>
    );
}
