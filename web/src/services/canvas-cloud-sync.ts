import localforage from "localforage";

import { createCloudProject, getCloudProject, isCloudEnabled, listCloudProjects, saveCloudProject, serializeDoc, type CloudProject } from "@/services/canvas-cloud";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * 画布文档的云端同步。
 *
 * id 约定：本地 project.id 是 nanoid，云端 project.id 是服务端 uuid，
 * 二者通过 localforage 的 cloud_project_map 关联（localId -> {cloudId, revision}）。
 * 从云端拉回、且本地没有对应记录的画布，直接用云端 id 作为本地 id，
 * 之后它的 push 就天然一致，不需要再映射。
 */

type ProjectLink = { cloudId: string; revision: number };

const projectMap = localforage.createInstance({ name: "infinite-canvas", storeName: "cloud_project_map" });

async function getLink(localId: string): Promise<ProjectLink | null> {
    return projectMap.getItem<ProjectLink>(localId).catch(() => null);
}

async function setLink(localId: string, link: ProjectLink) {
    await projectMap.setItem(localId, link).catch(() => undefined);
}

function cloudToLocal(cloud: CloudProject, id: string): CanvasProject {
    let doc: Record<string, unknown> = {};
    try {
        doc = JSON.parse(cloud.doc || "{}");
    } catch {
        // 云端 doc 损坏时降级为空画布，不阻断整个列表。
    }
    return {
        id,
        title: cloud.title || (typeof doc.title === "string" ? doc.title : "未命名画布"),
        createdAt: typeof doc.createdAt === "string" ? doc.createdAt : new Date(cloud.created_at * 1000).toISOString(),
        updatedAt: new Date(cloud.updated_at * 1000).toISOString(),
        nodes: (doc.nodes as CanvasProject["nodes"]) || [],
        connections: (doc.connections as CanvasProject["connections"]) || [],
        chatSessions: (doc.chatSessions as CanvasProject["chatSessions"]) || [],
        activeChatId: (doc.activeChatId as string | null) ?? null,
        backgroundMode: (doc.backgroundMode as CanvasProject["backgroundMode"]) || "lines",
        showImageInfo: Boolean(doc.showImageInfo),
        viewport: (doc.viewport as CanvasProject["viewport"]) || { x: 0, y: 0, k: 1 },
    };
}

/** 把单个本地画布推到云端；首次推送自动在云端建项目并记录映射。 */
export async function pushProjectToCloud(project: CanvasProject) {
    if (!isCloudEnabled()) return;
    try {
        let link = await getLink(project.id);
        if (!link) {
            const created = await createCloudProject(project.title);
            link = { cloudId: created.id, revision: created.revision };
            await setLink(project.id, link);
        }
        const doc = await serializeDoc(project);
        const res = await saveCloudProject(link.cloudId, project.title, doc, link.revision);
        if (res.conflict) {
            // 别处已经改过：以服务端为准覆盖本地，避免双方互相覆盖。
            const remote = res.project;
            if (remote) {
                await setLink(project.id, { cloudId: link.cloudId, revision: remote.revision });
                useCanvasStore.getState().replaceProjects([cloudToLocal(remote, project.id), ...useCanvasStore.getState().projects.filter((p) => p.id !== project.id)]);
            }
        } else if (res.project) {
            await setLink(project.id, { cloudId: link.cloudId, revision: res.project.revision });
        }
    } catch {
        // 失败静默：本地已有副本，下次编辑再重试。
    }
}

/** 登录后拉云端画布，合并到本地（云端为准），并把本地多出来的推上去补齐。 */
export async function pullCloudToLocal() {
    if (!isCloudEnabled()) return;
    try {
        const list = await listCloudProjects();
        const local = useCanvasStore.getState().projects;

        // cloudId -> localId
        const cloudToLocalId = new Map<string, string>();
        for (const p of local) {
            const link = await getLink(p.id);
            if (link) cloudToLocalId.set(link.cloudId, p.id);
        }

        const merged = [...local];
        for (const cloud of list) {
            const detail = await getCloudProject(cloud.id);
            if (!detail) continue;
            const localId = cloudToLocalId.get(cloud.id) ?? cloud.id;
            await setLink(localId, { cloudId: cloud.id, revision: detail.revision });
            const project = cloudToLocal(detail, localId);
            const idx = merged.findIndex((p) => p.id === localId);
            if (idx >= 0) merged[idx] = project;
            else merged.unshift(project);
        }
        useCanvasStore.getState().replaceProjects(merged);
    } catch {
        // 拉取失败静默，保留本地数据。
    }
}
