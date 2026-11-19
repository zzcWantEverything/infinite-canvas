import { useEffect, useState } from "react";
import { App, Button, Spin } from "antd";
import dayjs from "dayjs";
import { CreditCard, Receipt, RotateCcw, Settings2, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchUsageLogs, USAGE_LOG_PAGE_SIZE, type UsageLog, type UsageLogType } from "@/services/api/logs";
import { fetchPricingSnapshot } from "@/services/api/pricing";
import { catalogVariant } from "@/services/api/model-catalog";
import { useUserStore } from "@/stores/use-user-store";
import { quotaToYuan, yuanToQuota } from "@/lib/quota";
import { cn } from "@/lib/utils";

type LedgerFilter = "all" | 1 | 2 | 6;

const FILTERS: Array<{ key: LedgerFilter; labelKey: string }> = [
    { key: "all", labelKey: "wallet.filterAll" },
    { key: 1, labelKey: "wallet.filterTopup" },
    { key: 2, labelKey: "wallet.filterConsume" },
    { key: 6, labelKey: "wallet.filterRefund" },
];

function logMeta(type: UsageLogType) {
    switch (type) {
        case 1:
            return { icon: CreditCard, titleKey: "wallet.typeTopup", income: true };
        case 2:
            return { icon: Sparkles, titleKey: "wallet.typeConsume", income: false };
        case 6:
            return { icon: RotateCcw, titleKey: "wallet.typeRefund", income: true };
        case 3:
            return { icon: Settings2, titleKey: "wallet.typeManage", income: false };
        case 5:
            return { icon: TriangleAlert, titleKey: "wallet.typeError", income: false };
        default:
            return { icon: Receipt, titleKey: "wallet.typeSystem", income: true };
    }
}

/** 后端 content 里塞的是「操作 text_to_video, 计算参数: seconds: 6」这种字段串，直接展示没法读。
 *  列表只给一行人类可读的动作：图片生成 / 视频生成 / 充值 / 退款。 */
function resolveActionKey(item: UsageLog): string {
    if (item.type === 1) return "wallet.typeTopup";
    if (item.type === 6) return "wallet.typeRefund";
    if (item.type === 3) return "wallet.typeManage";
    if (item.type !== 2) return logMeta(item.type).titleKey;
    // 视频优先：image_to_video 同时含 image 和 video，先判视频才不会认错。
    const hint = `${item.model_name} ${item.content}`.toLowerCase();
    if (/video|视频/.test(hint)) return "wallet.actionVideo";
    if (/image|imagen|dall|midjourney|图片|绘图/.test(hint)) return "wallet.actionImage";
    if (/audio|tts|speech|音频|语音/.test(hint)) return "wallet.actionAudio";
    if (/text_to|chat|completion|文本|对话/.test(hint)) return "wallet.actionText";
    return "wallet.typeConsume";
}

/** 充值 / 后台调整的日志不带 quota（后端只在文案里写金额），从文案里把额度捞出来。 */
function resolveQuota(item: UsageLog): number {
    if (item.quota !== 0) return item.quota;
    if (item.type !== 1 && item.type !== 3) return item.quota;
    const matched = item.content.match(/充值\s*\$?\s*([\d.]+)\s*额度/) ?? item.content.match(/充值额度[:：]\s*([\d.]+)/);
    const yuan = matched ? Number(matched[1]) : NaN;
    return Number.isFinite(yuan) ? yuanToQuota(yuan) : item.quota;
}

/**
 * 余额明细：直接把 new-api 的 `/api/log/self` 摊开成一条条流水。
 * quota 恒为正数，收入还是支出由 type 决定（2 消费出账、1 充值 / 6 退款入账）。
 */
export function UsageLedger({ baseUrl, token }: { baseUrl: string; token: string }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const hasToken = Boolean(token);
    const [filter, setFilter] = useState<LedgerFilter>("all");
    const [items, setItems] = useState<UsageLog[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    // 日志里的 model_name 有时是渠道编码（vw_b05f3c4@207）而不是模型名，
    // 只有能对上价目表/目录的才当模型名展示，对不上就不显示这一行小字。
    const [knownModels, setKnownModels] = useState<Set<string> | null>(null);

    useEffect(() => {
        let alive = true;
        void fetchPricingSnapshot(baseUrl)
            .then((snapshot) => {
                if (alive && snapshot) setKnownModels(new Set(snapshot.models.keys()));
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [baseUrl]);

    useEffect(() => {
        // 依赖只放「有没有登录」，token 本身从 store 现取：access token 每次续期都会换新，
        // 挂进依赖会让流水在后台被反复重拉。
        const live = useUserStore.getState().session;
        if (!hasToken || !live?.token) return;
        let alive = true;
        setLoading(true);
        fetchUsageLogs(baseUrl, live.token, { page: 1, pageSize: USAGE_LOG_PAGE_SIZE, type: filter === "all" ? undefined : filter })
            .then((data) => {
                if (!alive) return;
                setItems(data.items);
                setTotal(data.total);
                setPage(1);
            })
            .catch((error) => {
                if (alive) void message.error(error instanceof Error ? error.message : t("wallet.loadFailed"));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [baseUrl, hasToken, filter, message, t]);

    const loadMore = async () => {
        setLoadingMore(true);
        try {
            const next = page + 1;
            const data = await fetchUsageLogs(baseUrl, token, { page: next, pageSize: USAGE_LOG_PAGE_SIZE, type: filter === "all" ? undefined : filter });
            setItems((value) => [...value, ...data.items]);
            setTotal(data.total);
            setPage(next);
        } catch (error) {
            void message.error(error instanceof Error ? error.message : t("wallet.loadFailed"));
        } finally {
            setLoadingMore(false);
        }
    };

    const hasMore = items.length < total;

    return (
        <section className="rounded-xl border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 px-5 py-4 dark:border-stone-800">
                <div>
                    <h2 className="text-sm font-medium text-stone-900 dark:text-stone-100">{t("wallet.ledgerTitle")}</h2>
                    <p className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">{t("wallet.ledgerHint")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                    {FILTERS.map((item) => (
                        <button
                            key={String(item.key)}
                            type="button"
                            onClick={() => setFilter(item.key)}
                            className={cn(
                                "rounded-full px-3 py-1 text-xs transition",
                                filter === item.key
                                    ? "bg-stone-200/80 font-medium dark:bg-stone-700"
                                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            {t(item.labelKey)}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex h-40 items-center justify-center">
                    <Spin />
                </div>
            ) : items.length ? (
                <div className="divide-y divide-stone-100 dark:divide-stone-800">
                    {items.map((item) => (
                        <LogRow key={item.id} item={item} knownModels={knownModels} />
                    ))}
                </div>
            ) : (
                <div className="flex h-40 items-center justify-center text-sm text-stone-400 dark:text-stone-500">{t("wallet.empty")}</div>
            )}

            <div className="flex items-center justify-center px-5 py-4">
                {hasMore ? (
                    <Button size="small" loading={loadingMore} onClick={() => void loadMore()}>
                        {t("wallet.loadMore")}
                    </Button>
                ) : items.length ? (
                    <span className="text-xs text-stone-400 dark:text-stone-500">{t("wallet.noMore")}</span>
                ) : null}
            </div>
        </section>
    );
}

function LogRow({ item, knownModels }: { item: UsageLog; knownModels: Set<string> | null }) {
    const { t } = useTranslation();
    const meta = logMeta(item.type);
    const Icon = meta.icon;
    const quota = resolveQuota(item);
    const sign = item.type === 2 ? -1 : item.type === 1 || item.type === 6 ? 1 : quota >= 0 ? 1 : -1;
    const income = sign > 0;
    const title = t(resolveActionKey(item));
    const rawModel = item.model_name.trim();
    const catalogName = catalogVariant(rawModel)?.display_name;
    // 渠道编码（vw_80a8763c@309 / vw_b05f3c4）不是模型名，认不出来就不显示这行小字；
    // 能对上目录展示名、对上价目表、或本身就是带连字符的模型名（grok-imagine-video）才展示。
    const readable = Boolean(catalogName) || Boolean(knownModels?.has(rawModel)) || (!rawModel.includes("@") && rawModel.includes("-"));
    const subtitle = readable ? catalogName || rawModel : "";
    const time = dayjs(item.created_at * 1000).format("YYYY-MM-DD HH:mm");
    // 单张图片常常只花几分钱，固定两位会显示成 0.03；小额最多三位并去掉尾零。
    const yuan = Math.abs(quotaToYuan(quota));
    const amount = yuan >= 0.1 ? yuan.toFixed(2) : String(Number(yuan.toFixed(3)));

    return (
        <div className="flex items-center gap-3 px-5 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-stone-800 dark:text-stone-100">{title}</div>
                <div className="mt-0.5 truncate text-xs text-stone-400 dark:text-stone-500">
                    {subtitle || <span className="sm:hidden">{time}</span>}
                    {subtitle ? <span className="sm:hidden"> · {time}</span> : null}
                </div>
            </div>
            <div className="hidden shrink-0 text-xs text-stone-400 sm:block dark:text-stone-500">{time}</div>
            <div className={cn("w-24 shrink-0 text-right font-mono text-sm tabular-nums", income ? "text-emerald-600 dark:text-emerald-400" : "text-stone-900 dark:text-stone-100")}>
                {income ? "+" : "-"}¥{amount}
            </div>
        </div>
    );
}
