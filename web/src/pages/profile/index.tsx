import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Tooltip } from "antd";
import { Activity, Copy, BarChart3, WalletCards } from "lucide-react";

import { fetchCurrentUser, fetchAffCode, redeemCode, type NewApiUser } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { useCopyText } from "@/hooks/use-copy-text";

// FIXED_BASE_URL 与 auth/index.tsx 保持一致
const FIXED_BASE_URL = (import.meta.env.VITE_API_BASE as string || "").replace(/\/+$/, "");

function formatQuota(quota: number) {
    return `¥${(quota / 500000).toFixed(2)}`;
}

export default function ProfilePage() {
    const { message } = App.useApp();
    const session = useUserStore((state) => state.session);
    const [user, setUser] = useState<NewApiUser | null>(session?.user ?? null);
    const [loading, setLoading] = useState(false);
    const [redeemInput, setRedeemInput] = useState("");
    const [redeeming, setRedeeming] = useState(false);
    const [affCode, setAffCode] = useState("");
    const copyText = useCopyText();

    const token = session?.token ?? "";

    const fetchUser = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            const u = await fetchCurrentUser(FIXED_BASE_URL, token);
            setUser(u);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => {
        void fetchUser();
        if (token) {
            fetchAffCode(FIXED_BASE_URL, token)
                .then(setAffCode)
                .catch(() => {});
        }
    }, [token, fetchUser]);

    async function handleRedeem() {
        if (!redeemInput.trim()) {
            void message.warning("请输入兑换码");
            return;
        }
        setRedeeming(true);
        try {
            const added = await redeemCode(FIXED_BASE_URL, token, redeemInput.trim());
            void message.success(`兑换成功，增加余额 ${formatQuota(added)}`);
            setRedeemInput("");
            void fetchUser();
        } catch (err) {
            void message.error(err instanceof Error ? err.message : "兑换失败");
        } finally {
            setRedeeming(false);
        }
    }

    // 推荐链接需要用真实域名，从 window.location 取当前站点
    const affLink = affCode ? `${window.location.origin}/sign-up?aff=${affCode}` : "";

    return (
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-8">
            <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">个人中心</h1>

            {/* 余额统计 */}
            <div className="grid grid-cols-3 divide-x divide-stone-200 rounded-xl border border-stone-200 bg-white dark:divide-stone-700 dark:border-stone-700 dark:bg-stone-900">
                {[
                    { label: "当前余额", value: formatQuota(user?.quota ?? 0), sub: "剩余配额", icon: <WalletCards className="size-4 text-emerald-500" /> },
                    { label: "总用量", value: formatQuota(user?.used_quota ?? 0), sub: "总消耗额度", icon: <BarChart3 className="size-4 text-blue-500" /> },
                    { label: "API 请求", value: (user?.request_count ?? 0).toLocaleString(), sub: "总请求数", icon: <Activity className="size-4 text-violet-500" /> },
                ].map((item) => (
                    <div key={item.label} className="flex flex-col gap-1 px-4 py-4">
                        <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                            {item.icon}
                            {item.label}
                        </div>
                        <div className="font-mono text-xl font-bold text-stone-900 dark:text-stone-100">{item.value}</div>
                        <div className="text-xs text-stone-400 dark:text-stone-500">{item.sub}</div>
                    </div>
                ))}
            </div>

            {/* 兑换码 */}
            <div className="rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-700 dark:bg-stone-900">
                <div className="mb-3 text-sm font-medium text-stone-700 dark:text-stone-300">🎫 有兑换码吗？</div>
                <div className="flex gap-2">
                    <Input
                        value={redeemInput}
                        onChange={(e) => setRedeemInput(e.target.value)}
                        placeholder="输入您的兑换码"
                        onPressEnter={handleRedeem}
                        allowClear
                    />
                    <Button type="primary" loading={redeeming} onClick={handleRedeem}>
                        兑换额度
                    </Button>
                </div>
            </div>

            {/* 推荐计划 */}
            <div className="rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-700 dark:bg-stone-900">
                <div className="mb-1 text-sm font-medium text-stone-700 dark:text-stone-300">🔗 推荐计划</div>
                <div className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                    用户通过您的推荐链接注册后，您即可获得奖励。
                </div>

                <div className="grid grid-cols-3 gap-3 mb-4">
                    {[
                        { label: "待确认", value: formatQuota(user?.aff_quota ?? 0) },
                        { label: "总收入", value: formatQuota(user?.aff_history_quota ?? 0) },
                        { label: "邀请", value: `${user?.aff_count ?? 0} 人` },
                    ].map((item) => (
                        <div key={item.label} className="rounded-lg bg-stone-50 px-3 py-2 text-center dark:bg-stone-800">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{item.label}</div>
                            <div className="mt-0.5 font-mono text-sm font-semibold text-stone-800 dark:text-stone-100">{item.value}</div>
                        </div>
                    ))}
                </div>

                {affLink ? (
                    <div className="flex gap-2">
                        <Input value={affLink} readOnly className="font-mono text-xs" />
                        <Tooltip title="复制推荐链接">
                            <Button icon={<Copy className="size-4" />} onClick={() => copyText(affLink)} />
                        </Tooltip>
                    </div>
                ) : (
                    <div className="text-xs text-stone-400">加载推荐链接中…</div>
                )}
            </div>
        </div>
    );
}
