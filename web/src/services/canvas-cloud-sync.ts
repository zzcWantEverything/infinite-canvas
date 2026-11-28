import localforage from "localforage";

import { localForageStorage } from "@/lib/localforage-storage";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob, syncStoredBlob } from "@/services/file-storage";
import {
    awaitCloudUploads,
    clearSignedUrlCache,
    collectStorageKeys,
    createCloudProject,
    currentCloudUserId,
    deleteCloudProject,
    getCachedObjectKeySync,
    getCloudProject,
    isCloudEnabled,
    listCloudProjects,
    repairCloudProjectMediaKeys,
    saveCloudProject,
    saveCloudProjectKeepalive,
    serializeDoc,
    type CloudProject,
} from "@/services/canvas-cloud";
import {
    CANVAS_LEGACY_CLAIMED_KEY,
    flushCanvasLocalPersistence,
    hydrateCanvasStoreForUser,
    loadPersistedCanvasStateForUser,
    readLegacyCanvasProjects,
    resetCanvasStoreForLogout,
    useCanvasStore,
    type CanvasProject,
} from "@/stores/canvas/use-canvas-store";
import { useCanvasSyncStore } from "@/stores/canvas/use-canvas-sync-store";

/**
 * 画布文档的云端同步（按 userId 严格隔离，防止同浏览器切换账号时串号融合）。
 *
 * id 约定：本地 project.id 是 nanoid 或服务端 uuid，云端 project.id 是服务端 uuid，
 * 二者通过 localforage 的 cloud_project_map 按 `u:${userId}:${localId}` 关联（{cloudId, revision}）。
 */

type ProjectLink = { cloudId: string; revision: number };

const projectMap = localforage.createInstance({ name: "infinite-canvas", storeName: "cloud_project_map" });
const syncLinkCache = new Map<string, ProjectLink>();
const lastPushedPayload = new Map<string, string>();
const pushInFlight = new Set<string>();
const pushQueued = new Map<string, CanvasProject>();
const pullInFlightByUser = new Map<number, Promise<void>>();
let switchEpoch = 0;

function projectMapKey(userId: number, localId: string) {
    return `u:${userId}:${localId}`;
}

function isCloudUuid(id: string) {
    return /^[0-9a-f]{32}$/i.test(id);
}

async function getLink(localId: string, userId = currentCloudUserId()): Promise<ProjectLink | null> {
    if (!userId || !localId) return null;
    const key = projectMapKey(userId, localId);
    const link = await projectMap.getItem<ProjectLink>(key).catch(() => null);
    if (link) syncLinkCache.set(key, link);
    return link;
}

async function setLink(localId: string, link: ProjectLink, userId = currentCloudUserId()) {
    if (!userId || !localId) return;
    const key = projectMapKey(userId, localId);
    syncLinkCache.set(key, link);
    await projectMap.setItem(key, link).catch(() => undefined);
}

async function removeLink(localId: string, userId = currentCloudUserId()) {
    if (!userId || !localId) return;
    const key = projectMapKey(userId, localId);
    syncLinkCache.delete(key);
    await projectMap.removeItem(key).catch(() => undefined);
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

function projectHasUnmappedLocalMedia(project: CanvasProject): boolean {
    const keys = new Set<string>();
    collectStorageKeys(project, keys);
    for (const key of keys) {
        if (key && !key.startsWith("media/") && !key.startsWith("data:")) return true;
    }
    return false;
}

function upsertProjectInStore(project: CanvasProject) {
    const state = useCanvasStore.getState();
    const exists = state.projects.some((p) => p.id === project.id);
    const next = exists ? state.projects.map((p) => (p.id === project.id ? project : p)) : [project, ...state.projects];
    state.replaceProjects(next, state.deletedProjects);
}

/** 切号 / 退出登录时清理同步运行时缓存，防止上一账号的推送或 URL 缓存串到下一账号。 */
export function resetCanvasSyncRuntime() {
    lastPushedPayload.clear();
    pushQueued.clear();
    syncLinkCache.clear();
    clearSignedUrlCache();
    useCanvasSyncStore.getState().reset();
}

/**
 * 把单个本地画布推到云端；首次推送自动在云端建项目并记录映射。
 * 同一画布串行排队，避免并发 PUT 互相打成 revision_conflict。
 */
export async function pushProjectToCloud(project: CanvasProject) {
    if (!isCloudEnabled()) return;
    const uid = currentCloudUserId();
    if (!uid || useCanvasStore.getState().activeUserId !== uid) return;

    const queueKey = projectMapKey(uid, project.id);
    if (pushInFlight.has(queueKey)) {
        pushQueued.set(queueKey, project);
        return;
    }
    pushInFlight.add(queueKey);
    try {
        await runPushProjectToCloud(uid, project);
    } finally {
        pushInFlight.delete(queueKey);
        const queued = pushQueued.get(queueKey);
        pushQueued.delete(queueKey);
        if (queued && currentCloudUserId() === uid && useCanvasStore.getState().activeUserId === uid) {
            const latest = useCanvasStore.getState().openProject(queued.id);
            if (latest) void pushProjectToCloud(latest);
        }
    }
}

async function runPushProjectToCloud(uid: number, project: CanvasProject) {
    const stillActive = () => currentCloudUserId() === uid && useCanvasStore.getState().activeUserId === uid;
    if (!stillActive()) return;

    useCanvasSyncStore.getState().setSaving();
    try {
        let link = await getLink(project.id, uid);
        if (!link && isCloudUuid(project.id)) {
            const existing = await getCloudProject(project.id);
            if (!stillActive()) return;
            if (existing) {
                link = { cloudId: existing.id, revision: existing.revision };
                await setLink(project.id, link, uid);
            }
        }
        if (!link) {
            const created = await createCloudProject(project.title);
            if (!stillActive()) return;
            link = { cloudId: created.id, revision: created.revision };
            await setLink(project.id, link, uid);
        }

        // 等还在上传的素材落地，serializeDoc 才能把它们替换成 object_key，而不是存成本地键。
        await awaitCloudUploads();
        if (!stillActive()) return;

        const doc = await serializeDoc(project);
        if (!stillActive()) return;

        const payloadKey = `${project.title}\0${doc}`;
        const lastKey = `${uid}:${link.cloudId}`;
        if (lastPushedPayload.get(lastKey) === payloadKey) {
            useCanvasSyncStore.getState().setSaved();
            return;
        }

        const res = await saveCloudProject(link.cloudId, project.title, doc, link.revision);
        if (!stillActive()) return;

        if (res.conflict) {
            // 别处已经改过：以服务端为准更新该画布并保留其它画布。
            const remote = res.project;
            if (remote) {
                await setLink(project.id, { cloudId: link.cloudId, revision: remote.revision }, uid);
                lastPushedPayload.set(lastKey, `${remote.title}\0${remote.doc || ""}`);
                if (stillActive()) upsertProjectInStore(cloudToLocal(remote, project.id));
            }
        } else if (res.project) {
            await setLink(project.id, { cloudId: link.cloudId, revision: res.project.revision }, uid);
            lastPushedPayload.set(lastKey, payloadKey);
        }
        if (stillActive()) useCanvasSyncStore.getState().setSaved();
    } catch (error) {
        if (!stillActive()) return;
        const message = error instanceof Error ? error.message : "保存失败";
        useCanvasSyncStore.getState().setError(message);
    }
}

function rewriteStorageKeysSync(value: unknown, userId: number): { rewritten: unknown; hasUnmappedLocal: boolean } {
    let hasUnmappedLocal = false;
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
                if (k === "storageKey" && typeof child === "string") {
                    if (!child || child.startsWith("media/") || child.startsWith("data:")) {
                        out[k] = child;
                    } else {
                        const mapped = getCachedObjectKeySync(child, userId);
                        if (mapped) {
                            out[k] = mapped;
                        } else {
                            hasUnmappedLocal = true;
                            out[k] = child;
                        }
                    }
                } else {
                    out[k] = walk(child);
                }
            }
            return out;
        }
        return v;
    };
    return { rewritten: walk(value), hasUnmappedLocal };
}

/** 关页时的 keepalive 推云：命中已有云端映射且无需新上传媒体时直接发 PUT；否则退回普通异步推云。 */
export function pushProjectKeepalive(project: CanvasProject): boolean {
    const uid = currentCloudUserId();
    if (!uid || useCanvasStore.getState().activeUserId !== uid) return false;
    const link = syncLinkCache.get(projectMapKey(uid, project.id));
    if (!link) {
        void pushProjectToCloud(project);
        return false;
    }
    const { rewritten, hasUnmappedLocal } = rewriteStorageKeysSync(project, uid);
    if (hasUnmappedLocal) {
        void pushProjectToCloud(project);
        return false;
    }
    const doc = JSON.stringify(rewritten);
    const lastKey = `${uid}:${link.cloudId}`;
    if (lastPushedPayload.get(lastKey) === `${project.title}\0${doc}`) return true;
    const sent = saveCloudProjectKeepalive(link.cloudId, project.title, doc, link.revision);
    if (!sent) void pushProjectToCloud(project);
    return sent;
}

/**
 * 账号会话切换入口（登录 / 切换账号 / 退出登录 / 刷新初始化）。
 * 先刷盘并清空上一账号内存，再加载当前 userId 的独立缓存并触发云端拉取。
 */
export async function switchCanvasSessionUser(userId: number | null): Promise<void> {
    const epoch = ++switchEpoch;
    await flushCanvasLocalPersistence();
    resetCanvasSyncRuntime();

    if (!userId) {
        await resetCanvasStoreForLogout();
        return;
    }

    // 同步清空内存中的上一账号画布，等待当前账号缓存加载。
    useCanvasStore.setState({
        activeUserId: userId,
        hydrated: false,
        projects: [],
        deletedProjects: [],
    });

    const saved = await loadPersistedCanvasStateForUser(userId);
    if (epoch !== switchEpoch || currentCloudUserId() !== userId) return;

    if (saved.exists) {
        await hydrateCanvasStoreForUser(userId, saved.projects, saved.deletedProjects);
        if (epoch !== switchEpoch || currentCloudUserId() !== userId) return;
        void pullCloudToLocal(userId);
        return;
    }

    await pullCloudToLocal(userId, { migrateLegacy: true, expectedEpoch: epoch });
    if (epoch === switchEpoch && currentCloudUserId() === userId && !useCanvasStore.getState().hydrated) {
        useCanvasStore.setState({
            activeUserId: userId,
            hydrated: true,
            projects: [],
            deletedProjects: [],
        });
    }
}

/** 登录后拉云端画布，按当前 userId 合并并移除已在云端删除的项目，必要时安全迁移历史草稿并补传本地键。 */
export async function pullCloudToLocal(
    expectedUid?: number,
    options?: { migrateLegacy?: boolean; expectedEpoch?: number },
): Promise<void> {
    if (!isCloudEnabled()) return;
    const uid = expectedUid ?? currentCloudUserId();
    if (!uid) return;
    if (options?.migrateLegacy) {
        return runPullCloudToLocal(uid, options);
    }
    const existing = pullInFlightByUser.get(uid);
    if (existing) return existing;
    const task = runPullCloudToLocal(uid, options).finally(() => {
        if (pullInFlightByUser.get(uid) === task) pullInFlightByUser.delete(uid);
    });
    pullInFlightByUser.set(uid, task);
    return task;
}

async function runPullCloudToLocal(
    uid: number,
    options?: { migrateLegacy?: boolean; expectedEpoch?: number },
): Promise<void> {
    const stillValid = () =>
        currentCloudUserId() === uid && (options?.expectedEpoch === undefined || options.expectedEpoch === switchEpoch);

    try {
        const list = await listCloudProjects();
        if (!stillValid()) return;

        const cloudById = new Map(list.map((c) => [c.id, c]));
        const storeState = useCanvasStore.getState();
        const rawLocal = storeState.activeUserId === uid ? storeState.projects : [];

        // 过滤已在云端被删除的已同步项目，只保留本地尚存云端的项目及未建云端映射的纯本地草稿。
        const cloudToLocalLink = new Map<string, { localId: string; revision: number }>();
        const merged: CanvasProject[] = [];
        for (const p of rawLocal) {
            const link = await getLink(p.id, uid);
            if (!stillValid()) return;
            if (link) {
                if (!cloudById.has(link.cloudId)) {
                    await removeLink(p.id, uid);
                    continue;
                }
                cloudToLocalLink.set(link.cloudId, { localId: p.id, revision: link.revision });
                merged.push(p);
            } else if (isCloudUuid(p.id)) {
                if (!cloudById.has(p.id)) continue;
                cloudToLocalLink.set(p.id, { localId: p.id, revision: 0 });
                merged.push(p);
            } else {
                merged.push(p);
            }
        }

        const legacyMatchedLocalId = new Map<string, string>();
        const pendingLegacyPushIds = new Set<string>();
        const pendingLegacyPushes: CanvasProject[] = [];

        if (options?.migrateLegacy) {
            const legacyProjects = await readLegacyCanvasProjects();
            if (!stillValid()) return;
            const claimedBy = await localForageStorage.getItem(CANVAS_LEGACY_CLAIMED_KEY);
            const canClaimUnlinkedDrafts = !claimedBy || claimedBy === String(uid);
            let sawAnyLegacy = false;

            for (const lp of legacyProjects) {
                if (!lp?.id) continue;
                sawAnyLegacy = true;
                const legacyLink = await projectMap.getItem<ProjectLink>(lp.id).catch(() => null);
                const matchedCloud = (legacyLink ? cloudById.get(legacyLink.cloudId) : undefined) || cloudById.get(lp.id);

                if (matchedCloud) {
                    if (!legacyMatchedLocalId.has(matchedCloud.id)) {
                        legacyMatchedLocalId.set(matchedCloud.id, lp.id);
                    }
                    const localUpdatedMs = Date.parse(lp.updatedAt || "");
                    if (Number.isFinite(localUpdatedMs) && localUpdatedMs > matchedCloud.updated_at * 1000 + 2000) {
                        await setLink(lp.id, { cloudId: matchedCloud.id, revision: matchedCloud.revision }, uid);
                        cloudToLocalLink.set(matchedCloud.id, { localId: lp.id, revision: matchedCloud.revision });
                        if (!merged.some((m) => m.id === lp.id)) merged.unshift(lp);
                        pendingLegacyPushIds.add(lp.id);
                        pendingLegacyPushes.push(lp);
                    }
                    continue;
                }

                // 仅认领既没有绑定到任何云端记录、ID 也不是云端 UUID 的纯本地新建草稿（且只由首次迁入的账号认领一次）。
                if (canClaimUnlinkedDrafts && !legacyLink && !isCloudUuid(lp.id)) {
                    if (!merged.some((m) => m.id === lp.id)) {
                        merged.push(lp);
                        pendingLegacyPushes.push(lp);
                    }
                }
            }

            if (sawAnyLegacy && !claimedBy) {
                await localForageStorage.setItem(CANVAS_LEGACY_CLAIMED_KEY, String(uid));
            }
        }

        let changed = merged.length !== rawLocal.length || Boolean(options?.migrateLegacy);
        for (const cloud of list) {
            if (!stillValid()) return;
            const existing = cloudToLocalLink.get(cloud.id);
            const localId = existing?.localId ?? legacyMatchedLocalId.get(cloud.id) ?? cloud.id;
            const idx = merged.findIndex((p) => p.id === localId);

            if (idx >= 0 && pendingLegacyPushIds.has(localId)) continue;
            if (existing && existing.revision === cloud.revision && idx >= 0 && !projectHasUnmappedLocalMedia(merged[idx])) {
                continue;
            }

            const fetched = await getCloudProject(cloud.id);
            if (!fetched || !stillValid()) return;
            const detail = (await repairCloudProjectMediaKeys(cloud.id, fetched).catch(() => fetched)) || fetched;
            if (!stillValid()) return;

            await setLink(localId, { cloudId: cloud.id, revision: detail.revision }, uid);
            lastPushedPayload.set(`${uid}:${cloud.id}`, `${detail.title}\0${detail.doc || ""}`);
            const project = cloudToLocal(detail, localId);
            if (idx >= 0) merged[idx] = project;
            else merged.unshift(project);
            changed = true;
        }

        if (!stillValid()) return;
        if (changed || !storeState.hydrated || storeState.activeUserId !== uid) {
            await hydrateCanvasStoreForUser(uid, merged, []);
        }
        for (const draft of pendingLegacyPushes) {
            if (!stillValid()) return;
            void pushProjectToCloud(draft);
        }
    } catch {
        // 拉取失败静默，保留本地状态；首次迁移失败不写入空缓存，下次刷新可重试迁移。
    }
}

/** 按本地画布 id 修复其云端文档里的本地键（直接打开画布时触发，同时把新 revision 写回本地映射避免冲突）。 */
export async function repairProjectMediaKeysByLocalId(localId: string): Promise<void> {
    const uid = currentCloudUserId();
    if (!uid || !isCloudEnabled()) return;
    let link = await getLink(localId, uid);
    if (!link && isCloudUuid(localId)) {
        link = { cloudId: localId, revision: 0 };
    }
    if (!link) return;
    const repaired = await repairCloudProjectMediaKeys(link.cloudId).catch(() => null);
    if (!repaired || currentCloudUserId() !== uid || useCanvasStore.getState().activeUserId !== uid) return;
    if (repaired.revision > link.revision) {
        await setLink(localId, { cloudId: link.cloudId, revision: repaired.revision }, uid);
        lastPushedPayload.set(`${uid}:${link.cloudId}`, `${repaired.title}\0${repaired.doc || ""}`);
        upsertProjectInStore(cloudToLocal(repaired, localId));
    }
}

/** 在当前用户下直接从云端拉取单个画布（支持直链打开或本机尚未缓存时打开）。 */
export async function ensureProjectLoadedFromCloud(projectId: string): Promise<CanvasProject | null> {
    const uid = currentCloudUserId();
    if (!uid || !isCloudEnabled()) return null;
    const link = await getLink(projectId, uid);
    const cloudId = link?.cloudId ?? (isCloudUuid(projectId) ? projectId : null);
    if (!cloudId) return null;

    const fetched = await getCloudProject(cloudId);
    if (!fetched || currentCloudUserId() !== uid) return null;
    const detail = (await repairCloudProjectMediaKeys(cloudId, fetched).catch(() => fetched)) || fetched;
    if (currentCloudUserId() !== uid || useCanvasStore.getState().activeUserId !== uid) return null;

    await setLink(projectId, { cloudId, revision: detail.revision }, uid);
    lastPushedPayload.set(`${uid}:${cloudId}`, `${detail.title}\0${detail.doc || ""}`);
    const local = cloudToLocal(detail, projectId);
    upsertProjectInStore(local);
    return local;
}

/** 删除画布后同步软删当前账号名下云端对应记录并清理本地映射（后端强制按 user_id 隔离校验）。 */
export async function deleteProjectsFromCloud(localIds: string[]): Promise<void> {
    if (!isCloudEnabled()) return;
    const uid = currentCloudUserId();
    if (!uid) return;

    await Promise.all(
        [...new Set(localIds)].map(async (localId) => {
            const link = await getLink(localId, uid);
            const cloudId = link?.cloudId ?? (isCloudUuid(localId) ? localId : null);
            const queueKey = projectMapKey(uid, localId);
            pushQueued.delete(queueKey);
            if (cloudId) {
                lastPushedPayload.delete(`${uid}:${cloudId}`);
                await deleteCloudProject(cloudId).catch(() => undefined);
            }
            await removeLink(localId, uid);
        }),
    );
}

/** 导入画布后，把 zip 里的素材补传云端；返回时上传已落地，可以安全推送文档。 */
export async function uploadImportedAssets(storageKeys: string[]) {
    if (!isCloudEnabled()) return;
    await Promise.all(
        [...new Set(storageKeys)].map(async (key) => {
            if (!key || key.startsWith("media/")) return;
            const blob = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
            if (blob) await syncStoredBlob(key, blob);
        }),
    );
    await awaitCloudUploads();
}
