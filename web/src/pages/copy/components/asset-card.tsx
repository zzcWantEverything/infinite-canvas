import { ImagePlus, Library, Loader2, Map, Package, Pencil, Sparkles, TriangleAlert, Trash2, User } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CopyItem } from "@/services/api/copy-video";
import type { CopyMedia } from "@/components/copy/types";

type AssetCardProps = {
    item: CopyItem;
    kind: "role" | "scene" | "item";
    /** 缩略图比例（角色跟随「角色样式」，场景/物品默认 16:9） */
    aspectRatio?: string;
    media?: CopyMedia;
    running?: boolean;
    failed?: boolean;
    disabled?: boolean;
    onEdit: () => void;
    onGenerate: () => void;
    onUpload: () => void;
    onRemove: () => void;
    /** 点图看大图 */
    onPreview?: () => void;
    /** 从「我的素材」里挑一张 */
    onPickLibrary?: () => void;
};

const kindIcon = { role: User, scene: Map, item: Package } as const;

const toCssRatio = (ratio: string | undefined, fallback: string) => {
    const [w, h] = String(ratio || "").split(":").map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w} / ${h}` : fallback;
};

/** 角色/场景/物品卡片：上图下名，底部生图 + 上传替换 + 编辑，和参考产品的信息密度一致。 */
export function AssetCard({ item, kind, aspectRatio, media, running, failed, disabled, onEdit, onGenerate, onUpload, onRemove, onPreview, onPickLibrary }: AssetCardProps) {
    const { t } = useTranslation();
    const Icon = kindIcon[kind];
    return (
        <div className="group relative overflow-hidden rounded-xl border border-stone-200/70 bg-background transition-colors hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700">
            <button
                type="button"
                onClick={onRemove}
                className="absolute right-1.5 top-1.5 z-10 rounded-full bg-black/60 p-1 opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100"
                style={{ color: "#fff" }}
                title={t("copyVideo.deleteAsset")}
            >
                <Trash2 className="size-3" />
            </button>
            <div
                className="relative flex w-full items-center justify-center overflow-hidden bg-stone-100 dark:bg-stone-900"
                style={{ aspectRatio: toCssRatio(aspectRatio, kind === "role" ? "3 / 4" : "16 / 9") }}
            >
                {media?.url ? (
                    <img
                        src={media.url}
                        alt={item.name}
                        onClick={onPreview}
                        className={`h-full w-full object-cover object-top ${onPreview ? "cursor-zoom-in" : ""}`}
                    />
                ) : failed ? (
                    <div className="flex flex-col items-center gap-1 px-2 text-center">
                        <TriangleAlert className="size-5 text-rose-400" />
                        <span className="text-[10px] leading-4 text-rose-400">{t("copyVideo.imageFailed")}</span>
                    </div>
                ) : (
                    <Icon className="size-7 text-stone-300 dark:text-stone-700" />
                )}
                {running ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm">
                        <Loader2 className="size-5 animate-spin" style={{ color: "#fff" }} />
                    </div>
                ) : null}
            </div>
            <div className="px-2 pb-1 pt-1.5">
                <h4 className="truncate text-[11px] font-medium text-stone-800 dark:text-stone-100">{item.name}</h4>
                <p className="mt-0.5 line-clamp-1 text-[9px] leading-relaxed text-stone-400 dark:text-stone-500">{item.description || t("copyVideo.noDescription")}</p>
            </div>
            <div className="flex gap-1.5 px-2 pb-2">
                <button
                    type="button"
                    onClick={onGenerate}
                    disabled={disabled || running}
                    className="flex h-6 flex-1 items-center justify-center gap-1 rounded-md bg-stone-100 text-[10px] font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                >
                    {running ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                    {media ? t("copyVideo.regenerate") : t("copyVideo.genImage")}
                </button>
                <button
                    type="button"
                    onClick={onUpload}
                    disabled={disabled || running}
                    className="flex size-6 items-center justify-center rounded-md bg-stone-100 text-stone-500 transition-colors hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                    title={t("copyVideo.uploadImage")}
                >
                    <ImagePlus className="size-3.5" />
                </button>
                {onPickLibrary ? (
                    <button
                        type="button"
                        onClick={onPickLibrary}
                        disabled={disabled || running}
                        className="flex size-6 items-center justify-center rounded-md bg-stone-100 text-stone-500 transition-colors hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                        title={t("copyVideo.pickFromLibrary")}
                    >
                        <Library className="size-3.5" />
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={onEdit}
                    className="flex size-6 items-center justify-center rounded-md bg-stone-100 text-stone-500 transition-colors hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                    title={t("copyVideo.edit")}
                >
                    <Pencil className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
