import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Image as ImageIcon, Pencil, Play, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { pushProjectToCloud } from "@/services/canvas-cloud-sync";
import { resolveVideoPreview } from "@/services/file-storage";
import { ensureImagePreview, previewUrlFor, resolveImageUrl } from "@/services/image-storage";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { pickProjectCover } from "@/lib/canvas/canvas-project-cover";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

type CoverPreviewState = {
    status: "idle" | "loading" | "ready" | "error";
    imgSrc?: string;
    videoSrc?: string;
    usedThumbnail?: boolean;
};

export function CanvasProjectCard({ project }: { project: CanvasProject }) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const cardRef = useRef<HTMLElement>(null);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const cover = useMemo(() => pickProjectCover(project), [project.nodes]);
    const coverSignature = cover ? `${cover.kind}:${cover.storageKey || ""}:${cover.fallbackUrl || ""}` : "";
    const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
    const [preview, setPreview] = useState<CoverPreviewState>({ status: "idle" });

    useEffect(() => {
        if (visible) return;
        const element = cardRef.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "200px" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!cover) {
            setPreview({ status: "idle" });
            return;
        }
        if (!visible) return;

        let cancelled = false;
        setPreview({ status: "loading" });

        void (async () => {
            if (cover.kind === "image") {
                const cachedThumb = cover.storageKey ? previewUrlFor(cover.storageKey) || (await ensureImagePreview(cover.storageKey)) : undefined;
                if (cancelled) return;
                if (cachedThumb) {
                    setPreview({ status: "ready", imgSrc: cachedThumb, usedThumbnail: true });
                    return;
                }
                const resolved = await resolveImageUrl(cover.storageKey, cover.fallbackUrl || "");
                if (cancelled) return;
                setPreview(resolved ? { status: "ready", imgSrc: resolved, usedThumbnail: false } : { status: "error" });
                return;
            }

            const { posterUrl, videoUrl } = await resolveVideoPreview(cover.storageKey, cover.fallbackUrl || "");
            if (cancelled) return;
            if (posterUrl) {
                setPreview({ status: "ready", imgSrc: posterUrl });
            } else if (videoUrl) {
                setPreview({ status: "ready", videoSrc: videoUrl.includes("#") ? videoUrl : `${videoUrl}#t=0.1` });
            } else {
                setPreview({ status: "error" });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [coverSignature, visible]);

    const handleImageError = () => {
        if (preview.usedThumbnail && cover?.kind === "image") {
            void resolveImageUrl(cover.storageKey, cover.fallbackUrl || "").then((resolved) => {
                setPreview(resolved && resolved !== preview.imgSrc ? { status: "ready", imgSrc: resolved, usedThumbnail: false } : { status: "error" });
            });
            return;
        }
        setPreview({ status: "error" });
    };

    const open = () => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        const updated = useCanvasStore.getState().openProject(project.id);
        if (updated) void pushProjectToCloud(updated);
        stopEditing();
    };

    return (
        <article ref={cardRef} className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    <input
                        type="checkbox"
                        checked={selected}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => toggleSelected(project.id, event.target.checked)}
                        className="mt-1 size-4 shrink-0 accent-stone-950 dark:accent-stone-100"
                        aria-label={t("canvas.project.select", { name: project.title })}
                    />
                    {editing ? (
                        <Input className="min-w-0 flex-1" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                    ) : (
                        <button
                            type="button"
                            className="min-w-0 flex-1 cursor-pointer text-left"
                            onClick={(event) => {
                                event.stopPropagation();
                                open();
                            }}
                        >
                            <h2 className="truncate text-xl font-semibold">{project.title}</h2>
                            <p className="mt-2.5 text-sm leading-6 text-stone-600 dark:text-stone-400">
                                {t("canvas.project.stats", { nodes: project.nodes.length, connections: project.connections.length })}
                            </p>
                        </button>
                    )}
                </div>

                <div className="relative h-[80px] w-[112px] shrink-0 overflow-hidden rounded-xl border border-stone-300/60 bg-stone-200/50 dark:border-white/10 dark:bg-white/[0.04]">
                    {preview.status === "ready" && preview.imgSrc ? (
                        <img src={preview.imgSrc} alt={project.title} loading="lazy" decoding="async" onError={handleImageError} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                    ) : preview.status === "ready" && preview.videoSrc ? (
                        <video src={preview.videoSrc} preload="metadata" muted playsInline onError={() => setPreview({ status: "error" })} className="pointer-events-none h-full w-full object-cover" />
                    ) : cover && (preview.status === "loading" || preview.status === "idle") ? (
                        <div className="h-full w-full animate-pulse bg-stone-200/80 dark:bg-white/10" />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center text-stone-400/75 dark:text-stone-500">
                            <ImageIcon className="size-5" />
                        </div>
                    )}
                    {cover?.kind === "video" && preview.status === "ready" ? (
                        <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                            <Play className="size-2.5 fill-current" />
                        </span>
                    ) : null}
                </div>
            </div>
            <div className="mt-5 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">{t("canvas.project.updated", { date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label={t("canvas.project.saveName")} />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label={t("canvas.project.cancelRename")} />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects([project], project.title || t("canvas.title"))} aria-label={t("canvas.project.export")} />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label={t("canvas.project.rename")} />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label={t("canvas.project.delete")} />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
