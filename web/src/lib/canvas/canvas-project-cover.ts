import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeStatus } from "@/types/canvas";

export type CanvasProjectCover = {
    kind: "image" | "video";
    storageKey?: string;
    fallbackUrl?: string;
};

function isUnavailableStatus(status?: CanvasNodeStatus): boolean {
    return status === "error" || status === "loading" || status === "pending";
}

function cleanStorageKey(key?: string): string | undefined {
    const trimmed = key?.trim();
    return trimmed || undefined;
}

function usableFallbackUrl(url?: string): string | undefined {
    const trimmed = url?.trim();
    // Refreshing invalidates prior-session blob: URLs, so rely on storageKey instead.
    if (!trimmed || trimmed.startsWith("blob:")) return undefined;
    return trimmed;
}

/**
 * Pick the first valid media node (image or video, strictly in node order) as the canvas cover preview.
 */
export function pickProjectCover(project: Pick<CanvasProject, "nodes">): CanvasProjectCover | null {
    for (const node of project.nodes || []) {
        if (node.type === CanvasNodeType.Image) {
            const images = node.metadata?.images;
            if (Array.isArray(images) && images.length > 0) {
                const primaryId = node.metadata?.primaryImageId;
                const primary = primaryId ? images.find((item) => item.id === primaryId) : undefined;
                const ordered = primary ? [primary, ...images.filter((item) => item.id !== primary.id)] : images;
                for (const item of ordered) {
                    if (isUnavailableStatus(item.status)) continue;
                    const storageKey = cleanStorageKey(item.storageKey);
                    const fallbackUrl = usableFallbackUrl(item.content);
                    if (storageKey || fallbackUrl) return { kind: "image", storageKey, fallbackUrl };
                }
            }
            if (!isUnavailableStatus(node.metadata?.status)) {
                const storageKey = cleanStorageKey(node.metadata?.storageKey);
                const fallbackUrl = usableFallbackUrl(node.metadata?.content);
                if (storageKey || fallbackUrl) return { kind: "image", storageKey, fallbackUrl };
            }
        } else if (node.type === CanvasNodeType.Video) {
            if (!isUnavailableStatus(node.metadata?.status)) {
                const storageKey = cleanStorageKey(node.metadata?.storageKey);
                const fallbackUrl = usableFallbackUrl(node.metadata?.content);
                if (storageKey || fallbackUrl) return { kind: "video", storageKey, fallbackUrl };
            }
        }
    }
    return null;
}
