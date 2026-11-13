import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { encodeChannelModel, modelOptionLabel, modelOptionName, normalizedBaseUrlMatch, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchUserVideoModels } from "@/services/api/auth";
import { reportApiError } from "@/services/api/http";
import { catalogGroupOf, catalogVariant, modelCatalogVersion, subscribeModelCatalog } from "@/services/api/model-catalog";
import { groupModelOptions } from "@/lib/model-picker-groups";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const session = useUserStore((state) => state.session);

    // 视频模型直接从服务器拉取，并用当前渠道 id 编码，确保 resolveModelChannel 能找到有效凭据。
    // /api/user/models 使用 UserAuth（session token），apiKey 是渠道凭据，两者不互通。
    const [serverVideoModels, setServerVideoModels] = useState<string[]>([]);
    useEffect(() => {
        if (capability !== "video" || !session?.baseUrl || !session?.token) return;
        const matchingChannel = config.channels.find((ch) => normalizedBaseUrlMatch(ch.baseUrl, session.baseUrl)) ?? config.channels[0];
        const channelId = matchingChannel?.id ?? "default";
        fetchUserVideoModels(session.baseUrl, session.token)
            .then((models) => {
                if (!models.length) return;
                setServerVideoModels(models.map((m) => encodeChannelModel(channelId, m)));
            })
            .catch(reportApiError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capability, session?.baseUrl, session?.token]);

    const configOptions = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);

    // 视频模型：服务器列表优先；拉到了就用服务器的，没拉到（或不是视频能力）就用配置列表。
    const options = capability === "video" && serverVideoModels.length > 0 ? serverVideoModels : configOptions;

    // 网关目录把同一款模型的多条线路归到一张卡片（variant_group），运营也会直接在展示名里
    // 写分组（「高清视觉 · sd2.5 1080P」）。两种写法都按同一套规则折叠：前缀做组标题，
    // 条目只显示线路名，避免同一串文字出现两次。
    const catalogVersion = useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
    const optionGroups = useMemo(
        () =>
            groupModelOptions(
                options.map((option) => {
                    const name = modelOptionName(option);
                    const card = catalogGroupOf(name);
                    return {
                        value: option,
                        name,
                        card: card ? { key: card.model, displayName: card.display_name, variantCount: card.variants.length } : null,
                        variantDisplayName: catalogVariant(name)?.display_name ?? null,
                    };
                }),
            ),
        [options, catalogVersion],
    );

    // 当有服务器模型列表时，把 current 规范化到列表格式，保证 Radix Select 能找到匹配项。
    const current = useMemo(() => {
        const raw = value || "";
        if (capability !== "video" || !serverVideoModels.length) return raw;
        if (serverVideoModels.includes(raw)) return raw;
        // 提取纯模型名后查找对应编码
        const modelName = modelOptionName(raw);
        return serverVideoModels.find((m) => modelOptionName(m) === modelName) ?? "";
    }, [capability, serverVideoModels, value]);

    // 节点上残留的模型名不在服务端列表里（例如已下架的 ark 模型）时，自动纠正为列表首个可用模型。
    // 否则界面显示为空，但节点里仍存着旧模型名，用户不重新选就会把已下线的模型提交出去。
    useEffect(() => {
        if (capability !== "video" || !serverVideoModels.length || current) return;
        onChange(serverVideoModels[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capability, current, serverVideoModels]);
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                // 视频能力：服务器已提供模型列表时不触发配置弹窗；其他能力保留原逻辑。
                if (nextOpen && !options.length && config.channelMode === "local" && capability !== "video") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelOptionLabel(config, current) : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {optionGroups.length ? (
                    optionGroups.map((group) => {
                        if (!group.header) {
                            const only = group.items[0];
                            return (
                                <SelectItem key={only.value} value={only.value} textValue={modelOptionLabel(config, only.value)}>
                                    <ModelLabel config={config} model={only.value} />
                                </SelectItem>
                            );
                        }
                        return (
                            <SelectGroup key={group.key}>
                                <SelectLabel>{group.label}</SelectLabel>
                                {group.items.map((item) => (
                                    <SelectItem key={item.value} value={item.value} textValue={modelOptionLabel(config, item.value)}>
                                        <ModelLabel config={config} model={item.value} label={item.label} />
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        );
                    })
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model, label }: { config: AiConfig; model: string; label?: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{label || modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
