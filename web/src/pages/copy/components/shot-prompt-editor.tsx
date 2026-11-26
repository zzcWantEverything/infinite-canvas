import { Fragment, useMemo, useState } from "react";
import { Button, Input, Popover } from "antd";
import { Copy, ImageIcon, Map as MapIcon, Package, Plus, Sparkles, TriangleAlert, User, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CopyMedia } from "@/components/copy/types";
import { cn } from "@/lib/utils";
import {
    splitPromptAssetTokens,
    type CopyAssetKind,
    type CopyAssetSection,
    type CopyItem,
    type CopyResolvedAsset,
    type ShotReferenceBinding,
} from "@/services/api/copy-video";
import type { ReferenceImage } from "@/types/image";

const kindMeta: Record<
    CopyAssetKind,
    {
        icon: typeof User;
        labelKey: string;
        chipClass: string;
        badgeClass: string;
    }
> = {
    role: {
        icon: User,
        labelKey: "copyVideo.assetKindRole",
        chipClass: "border-amber-300/80 bg-amber-50/90 text-amber-800 dark:border-amber-500/35 dark:bg-amber-950/55 dark:text-amber-200",
        badgeClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    scene: {
        icon: MapIcon,
        labelKey: "copyVideo.assetKindScene",
        chipClass: "border-sky-300/80 bg-sky-50/90 text-sky-800 dark:border-sky-500/35 dark:bg-sky-950/55 dark:text-sky-200",
        badgeClass: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    },
    item: {
        icon: Package,
        labelKey: "copyVideo.assetKindItem",
        chipClass: "border-violet-300/80 bg-violet-50/90 text-violet-800 dark:border-violet-500/35 dark:bg-violet-950/55 dark:text-violet-200",
        badgeClass: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    },
};

type AssetMentionChipProps = {
    name: string;
    prefix?: string;
    asset?: CopyResolvedAsset;
    media?: CopyMedia;
    running?: boolean;
    refIndex?: number;
    showSlot?: boolean;
    onRemove?: () => void;
    onGenerate?: () => void;
    onPreviewImage?: (url: string) => void;
};

/** `@资产名` 芯片：自带迷你缩略图，悬浮时弹出参考图大图预览，未生图时可一键生成。 */
export function AssetMentionChip({
    name,
    prefix = "@",
    asset,
    media,
    running,
    refIndex,
    showSlot = false,
    onRemove,
    onGenerate,
    onPreviewImage,
}: AssetMentionChipProps) {
    const { t } = useTranslation();
    const kind = asset?.kind ?? "item";
    const meta = kindMeta[kind];
    const Icon = meta.icon;

    const popoverContent = (
        <div className="w-60 space-y-2" onClick={(event) => event.stopPropagation()}>
            {media?.url ? (
                <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-900">
                    <img
                        src={media.url}
                        alt={name}
                        className={cn("max-h-52 w-full object-contain", onPreviewImage ? "cursor-zoom-in" : "")}
                        onClick={() => onPreviewImage?.(media.url)}
                    />
                </div>
            ) : (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-stone-200 bg-stone-50 px-2.5 py-3 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900/70 dark:text-stone-400">
                    <span>{t("copyVideo.noRefImageYet")}</span>
                    {onGenerate ? (
                        <Button size="small" type="primary" loading={running} icon={<Sparkles className="size-3" />} onClick={onGenerate}>
                            {t("copyVideo.genImage")}
                        </Button>
                    ) : null}
                </div>
            )}
            <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium", meta.badgeClass)}>
                        <Icon className="size-2.5" />
                        {t(meta.labelKey)}
                    </span>
                    <span className="truncate text-xs font-semibold text-stone-800 dark:text-stone-100">@{name}</span>
                    {refIndex ? (
                        <span className="ml-auto shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                            {t("copyVideo.refSlotLabel", { index: refIndex })}
                        </span>
                    ) : null}
                </div>
                {asset?.description ? <p className="line-clamp-3 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{asset.description}</p> : null}
            </div>
        </div>
    );

    return (
        <Popover content={popoverContent} placement="top" mouseEnterDelay={0.08} destroyOnHidden>
            <span
                onClick={(event) => event.stopPropagation()}
                className={cn(
                    "mx-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[11px] leading-tight transition-colors",
                    meta.chipClass,
                    !media?.url ? "border-dashed opacity-80" : "",
                )}
            >
                {media?.url ? (
                    <img src={media.url} alt="" className="size-3.5 shrink-0 rounded-[3px] object-cover object-top" />
                ) : (
                    <Icon className="size-3 shrink-0 opacity-75" />
                )}
                <span className="max-w-[130px] truncate font-medium">
                    {prefix}
                    {name}
                </span>
                {showSlot && refIndex ? (
                    <span className="rounded bg-black/10 px-1 text-[9px] font-semibold tabular-nums dark:bg-white/15">图{refIndex}</span>
                ) : null}
                {onRemove ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRemove();
                        }}
                        className="ml-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/15"
                        title={t("copyVideo.unbindAsset")}
                    >
                        <X className="size-2.5" />
                    </button>
                ) : null}
            </span>
        </Popover>
    );
}

type ShotPromptEditorProps = {
    value: string;
    placeholder?: string;
    assets: CopyResolvedAsset[];
    allAssetsByName: Map<string, CopyResolvedAsset>;
    itemImages: Record<string, CopyMedia>;
    itemStatus: Record<string, string>;
    bindings: ShotReferenceBinding[];
    copyTitle: string;
    onChange: (value: string) => void;
    onCopy: () => void;
    onPreviewImage: (url: string) => void;
    onGenerateAsset: (section: CopyAssetSection, id: string) => void;
};

/** 视频描述词编辑器：展示态高亮 `@资产名` 芯片并支持悬浮看参考图，点击文本区切入原生 TextArea 编辑。 */
export function ShotPromptEditor({
    value,
    placeholder,
    assets,
    allAssetsByName,
    itemImages,
    itemStatus,
    bindings,
    copyTitle,
    onChange,
    onCopy,
    onPreviewImage,
    onGenerateAsset,
}: ShotPromptEditorProps) {
    const [editing, setEditing] = useState(false);
    const assetNames = useMemo(() => Array.from(allAssetsByName.keys()), [allAssetsByName]);
    const slotByName = useMemo(() => {
        const map = new Map<string, number>();
        for (const binding of bindings) {
            if (binding.kind !== "storyboard" && !map.has(binding.name)) map.set(binding.name, binding.index);
        }
        return map;
    }, [bindings]);
    const tokens = useMemo(() => splitPromptAssetTokens(value, assetNames), [value, assetNames]);

    return (
        <div className="relative">
            {editing ? (
                <Input.TextArea
                    autoFocus
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onBlur={() => setEditing(false)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") setEditing(false);
                    }}
                    autoSize={{ minRows: 4, maxRows: 12 }}
                    placeholder={placeholder}
                    className="!pr-8"
                />
            ) : (
                <div
                    role="textbox"
                    tabIndex={0}
                    onClick={() => setEditing(true)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setEditing(true);
                        }
                    }}
                    className="thin-scrollbar max-h-[260px] min-h-[96px] cursor-text overflow-y-auto rounded-md border border-stone-200 bg-background px-2.5 py-1.5 pr-8 text-[13px] leading-[1.6] text-stone-800 transition-colors hover:border-stone-400 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-500"
                >
                    {value.trim() ? (
                        <div className="whitespace-pre-wrap break-words">
                            {tokens.map((token, index) => {
                                if (token.type === "text") return <Fragment key={index}>{token.value}</Fragment>;
                                const asset = assets.find((item) => item.name === token.name) ?? allAssetsByName.get(token.name);
                                return (
                                    <AssetMentionChip
                                        key={`${token.name}-${index}`}
                                        name={token.name}
                                        asset={asset}
                                        media={asset ? itemImages[asset.id] : undefined}
                                        running={asset ? itemStatus[asset.id] === "running" : false}
                                        refIndex={slotByName.get(token.name)}
                                        showSlot
                                        onPreviewImage={onPreviewImage}
                                        onGenerate={asset ? () => onGenerateAsset(asset.section, asset.id) : undefined}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <span className="text-xs text-stone-400 dark:text-stone-500">{placeholder}</span>
                    )}
                </div>
            )}
            <button
                type="button"
                onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    onCopy();
                }}
                className="absolute right-2 top-2 z-10 rounded bg-stone-100 p-1 text-stone-400 transition-colors hover:bg-stone-200 hover:text-stone-600 dark:bg-stone-800 dark:text-stone-500 dark:hover:bg-stone-700"
                title={copyTitle}
            >
                <Copy className="size-3.5" />
            </button>
        </div>
    );
}

type ShotAssetBarProps = {
    boundAssets: CopyResolvedAsset[];
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    itemImages: Record<string, CopyMedia>;
    itemStatus: Record<string, string>;
    refs: ReferenceImage[];
    bindings: ShotReferenceBinding[];
    disabled: boolean;
    onBindAsset: (section: CopyAssetSection, name: string) => void;
    onUnbindAsset: (section: CopyAssetSection, name: string) => void;
    onGenerateAsset: (section: CopyAssetSection, id: string) => void;
    onPreviewImage: (url: string) => void;
};

/** 分镜信息条中的绑定资产栏：展示芯片 + 添加/解绑参考资产 + 实际上传参考图状态徽标。 */
export function ShotAssetBar({
    boundAssets,
    roles,
    scenes,
    items,
    itemImages,
    itemStatus,
    refs,
    bindings,
    disabled,
    onBindAsset,
    onUnbindAsset,
    onGenerateAsset,
    onPreviewImage,
}: ShotAssetBarProps) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(false);

    const boundBySection = useMemo(() => {
        return {
            roles: new Set(boundAssets.filter((item) => item.section === "roles").map((item) => item.name)),
            scenes: new Set(boundAssets.filter((item) => item.section === "scenes").map((item) => item.name)),
            items: new Set(boundAssets.filter((item) => item.section === "items").map((item) => item.name)),
        };
    }, [boundAssets]);

    const slotById = useMemo(() => {
        const map = new Map<string, number>();
        for (const binding of bindings) {
            if (binding.id && !map.has(binding.id)) map.set(binding.id, binding.index);
        }
        return map;
    }, [bindings]);

    const groups: ReadonlyArray<{ section: CopyAssetSection; kind: CopyAssetKind; title: string; list: CopyItem[] }> = [
        { section: "roles", kind: "role", title: t("copyVideo.roles"), list: roles.filter((item) => !boundBySection.roles.has(item.name)) },
        { section: "scenes", kind: "scene", title: t("copyVideo.scenes"), list: scenes.filter((item) => !boundBySection.scenes.has(item.name)) },
        { section: "items", kind: "item", title: t("copyVideo.items"), list: items.filter((item) => !boundBySection.items.has(item.name)) },
    ];
    const hasUnbound = groups.some((group) => group.list.length > 0);

    const pickerContent = (
        <div className="max-h-64 w-56 space-y-2 overflow-y-auto">
            {hasUnbound ? (
                groups
                    .filter((group) => group.list.length > 0)
                    .map((group) => {
                        const Icon = kindMeta[group.kind].icon;
                        return (
                            <div key={group.section} className="space-y-1">
                                <div className="px-1 text-[10px] font-medium text-stone-400 dark:text-stone-500">{group.title}</div>
                                {group.list.map((item) => {
                                    const media = itemImages[item.id];
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => {
                                                onBindAsset(group.section, item.name);
                                                setPickerOpen(false);
                                            }}
                                            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-stone-700 transition-colors hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800"
                                        >
                                            {media?.url ? (
                                                <img src={media.url} alt="" className="size-5 shrink-0 rounded object-cover object-top" />
                                            ) : (
                                                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-stone-100 text-stone-400 dark:bg-stone-800">
                                                    <Icon className="size-3" />
                                                </span>
                                            )}
                                            <span className="min-w-0 flex-1 truncate">{item.name}</span>
                                            {!media?.url ? <span className="shrink-0 text-[10px] text-stone-400">{t("copyVideo.noImage")}</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })
            ) : (
                <div className="py-2 text-center text-xs text-stone-400">{t("copyVideo.allAssetsBound")}</div>
            )}
        </div>
    );

    const refSummaryContent = (
        <div className="w-56 space-y-1.5 text-xs">
            <div className="font-medium text-stone-700 dark:text-stone-200">{t("copyVideo.refOrderTitle")}</div>
            {bindings.map((binding) => (
                <div key={`${binding.index}-${binding.name}`} className="flex items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-300">
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums dark:bg-stone-800">
                        {t("copyVideo.refSlotLabel", { index: binding.index })}
                    </span>
                    <span className="truncate">{binding.kind === "storyboard" ? binding.name : `@${binding.name}`}</span>
                </div>
            ))}
        </div>
    );

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {boundAssets.map((asset) => (
                <AssetMentionChip
                    key={asset.id}
                    name={asset.name}
                    prefix=""
                    asset={asset}
                    media={itemImages[asset.id]}
                    running={itemStatus[asset.id] === "running"}
                    refIndex={slotById.get(asset.id)}
                    onPreviewImage={onPreviewImage}
                    onGenerate={() => onGenerateAsset(asset.section, asset.id)}
                    onRemove={disabled ? undefined : () => onUnbindAsset(asset.section, asset.name)}
                />
            ))}
            {!disabled ? (
                <Popover content={pickerContent} trigger="click" placement="bottomLeft" open={pickerOpen} onOpenChange={setPickerOpen} destroyOnHidden>
                    <button
                        type="button"
                        className="inline-flex h-5 items-center gap-0.5 rounded-md border border-dashed border-stone-300 px-1.5 text-[11px] text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-800 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-200"
                        title={t("copyVideo.bindAsset")}
                    >
                        <Plus className="size-3" />
                    </button>
                </Popover>
            ) : null}
            {refs.length > 0 ? (
                <Popover content={refSummaryContent} trigger="hover" placement="top" destroyOnHidden>
                    <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/35 dark:bg-emerald-950/40 dark:text-emerald-300">
                        <ImageIcon className="size-2.5" />
                        {t("copyVideo.refHint", { n: refs.length })}
                    </span>
                </Popover>
            ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/80 bg-amber-50/80 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
                    <TriangleAlert className="size-2.5" />
                    {t("copyVideo.noRefImageWarn")}
                </span>
            )}
        </div>
    );
}
