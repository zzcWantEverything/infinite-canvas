import axios from "axios";
import localforage from "localforage";

import { useUserStore } from "@/stores/use-user-store";

/**
 * 画布持久化的云端能力（new-api 的 /api/canvas/* + COS 直传）。
 *
 * 存储约定：
 * - 本地 storageKey（video:xxx / image:xxx）只作本地 IndexedDB 缓存键；
 * - 上传成功后映射到 COS objectKey（media/{uid}/...），映射按 userId 分区存 cloud_media_map；
 * - 画布 doc 推送到云端时，若仍有未映射的本地键会尝试从本地 IndexedDB 补传后替换成 objectKey；
 * - 拉回时字段仍是 objectKey，渲染层按 "media/" 前缀识别并换签名地址。
 */

export type PresignResult = {
    object_key: string;
    upload_url: string;
    expires_in: number;
    method: string;
    storage: string;
};

export type CloudProject = {
    id: string;
    title: string;
    doc: string;
    doc_bytes: number;
    revision: number;
    created_at: number;
    updated_at: number;
    media_count: number;
    media_bytes: number;
};

type MediaMeta = {
    width?: number;
    height?: number;
    duration_ms?: number;
    project_id?: string;
    /** 本地上传键（video:xxx / image:xxx）。登记到服务端后，换设备也能把历史文档里的本地键对回云端文件。 */
    local_key?: string;
};

const cloudMap = localforage.createInstance({ name: "infinite-canvas", storeName: "cloud_media_map" });
const syncMediaCache = new Map<string, string>();
const inflightBackfills = new Map<string, Promise<string | null>>();

const ALLOWED_CANVAS_MIMES: Record<"image" | "video" | "audio", Set<string>> = {
    image: new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    video: new Set(["video/mp4", "video/webm", "video/quicktime"]),
    audio: new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/ogg"]),
};

export function currentCloudUserId(): number | null {
    return useUserStore.getState().session?.user?.id ?? null;
}

export function isCloudEnabled() {
    return Boolean(useUserStore.getState().session?.token);
}

function apiUrl(path: string) {
    const base = useUserStore.getState().session?.baseUrl || "";
    return base ? `${base.trim().replace(/\/+$/, "")}${path}` : path;
}

async function api<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await axios.request({ method, url: apiUrl(path), data: body, requiresAuth: true });
    const payload = res.data as { success?: boolean; message?: string; data?: T };
    if (payload?.success === false) throw new Error(payload.message || "请求失败");
    return payload?.data as T;
}

// ===== 媒体 =====

export async function uploadToCloud(blob: Blob, kind: string, mimeType: string, meta?: MediaMeta): Promise<string> {
    const presign = await api<PresignResult>("POST", "/api/canvas/media/presign", {
        kind,
        mime_type: mimeType || "application/octet-stream",
        bytes: blob.size,
        project_id: meta?.project_id,
    });
    const putRes = await fetch(presign.upload_url, {
        method: presign.method || "PUT",
        headers: { "Content-Type": mimeType || "application/octet-stream" },
        body: blob,
    });
    if (!putRes.ok) throw new Error(`上传失败（HTTP ${putRes.status}）`);
    await api("POST", "/api/canvas/media", {
        object_key: presign.object_key,
        local_key: meta?.local_key,
        kind,
        mime_type: mimeType || "application/octet-stream",
        bytes: blob.size,
        width: meta?.width,
        height: meta?.height,
        duration_ms: meta?.duration_ms,
        project_id: meta?.project_id,
    });
    return presign.object_key;
}

const inflightUploads = new Set<Promise<unknown>>();

/** 跟踪一个素材上传，供推送画布前等待：避免文档推得比素材快，把本地键存进云端。 */
export function trackCloudUpload<T>(promise: Promise<T>): Promise<T> {
    inflightUploads.add(promise);
    void promise.catch(() => undefined).finally(() => inflightUploads.delete(promise));
    return promise;
}

/** 等当前所有上传落地（最多 timeoutMs），让 serializeDoc 能拿到真实 object_key。 */
export async function awaitCloudUploads(timeoutMs = 8000): Promise<void> {
    if (!inflightUploads.size) return;
    await Promise.race([
        Promise.allSettled([...inflightUploads]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

const SIGNED_URL_REFRESH_BUFFER_MS = 15 * 60_000;
const SIGNED_URL_BATCH_DELAY_MS = 50;
const SIGNED_URL_BATCH_MAX = 200;

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
let pendingBatchKeys = new Set<string>();
let pendingBatchWaiters: Array<{
    keys: string[];
    resolve: (urls: Record<string, string>) => void;
    reject: (err: unknown) => void;
}> = [];
let pendingBatchTimer: ReturnType<typeof setTimeout> | null = null;

function currentUserCachePrefix() {
    const uid = currentCloudUserId();
    return `${uid ?? 0}:`;
}

export function clearSignedUrlCache() {
    signedUrlCache.clear();
}

async function flushSignedUrlBatch() {
    pendingBatchTimer = null;
    const keys = [...pendingBatchKeys];
    const waiters = pendingBatchWaiters;
    pendingBatchKeys = new Set();
    pendingBatchWaiters = [];
    if (!keys.length) return;

    const prefix = currentUserCachePrefix();
    const fetched: Record<string, string> = {};
    try {
        for (let i = 0; i < keys.length; i += SIGNED_URL_BATCH_MAX) {
            const chunk = keys.slice(i, i + SIGNED_URL_BATCH_MAX);
            const data = await api<{ urls: Record<string, string>; expires_in?: number }>("POST", "/api/canvas/media/urls", { keys: chunk });
            const ttlMs = Math.max(60, data?.expires_in || 7200) * 1000;
            const expiresAt = Date.now() + ttlMs;
            for (const [k, url] of Object.entries(data?.urls || {})) {
                fetched[k] = url;
                signedUrlCache.set(prefix + k, { url, expiresAt });
            }
        }
        for (const waiter of waiters) {
            const out: Record<string, string> = {};
            for (const k of waiter.keys) {
                if (fetched[k]) out[k] = fetched[k];
            }
            waiter.resolve(out);
        }
    } catch (err) {
        for (const waiter of waiters) waiter.reject(err);
    }
}

export async function getCloudMediaUrls(keys: string[]): Promise<Record<string, string>> {
    if (!keys.length) return {};
    const prefix = currentUserCachePrefix();
    const now = Date.now();
    const result: Record<string, string> = {};
    const missing: string[] = [];

    for (const key of keys) {
        if (!key) continue;
        const hit = signedUrlCache.get(prefix + key);
        if (hit && hit.expiresAt - now > SIGNED_URL_REFRESH_BUFFER_MS) {
            result[key] = hit.url;
        } else {
            missing.push(key);
        }
    }
    if (!missing.length) return result;

    const fetched = await new Promise<Record<string, string>>((resolve, reject) => {
        for (const k of missing) pendingBatchKeys.add(k);
        pendingBatchWaiters.push({ keys: missing, resolve, reject });
        if (!pendingBatchTimer) {
            pendingBatchTimer = setTimeout(() => void flushSignedUrlBatch(), SIGNED_URL_BATCH_DELAY_MS);
        }
    });
    return { ...result, ...fetched };
}

// ===== 本地 storageKey -> objectKey 映射（按 userId 分区隔离） =====

function mediaMapKey(userId: number, localKey: string) {
    return `u:${userId}:${localKey}`;
}

function isOwnedObjectKey(objectKey: string | null | undefined, userId: number): objectKey is string {
    return Boolean(objectKey && objectKey.startsWith(`media/${userId}/`));
}

export function getCachedObjectKeySync(localKey: string, userId = currentCloudUserId()): string | null {
    if (!userId || !localKey) return null;
    return syncMediaCache.get(mediaMapKey(userId, localKey)) ?? null;
}

async function localObjectKeyFor(localKey: string, userId = currentCloudUserId()): Promise<string | null> {
    if (!userId || !localKey) return null;
    const scopedKey = mediaMapKey(userId, localKey);
    const mem = syncMediaCache.get(scopedKey);
    if (isOwnedObjectKey(mem, userId)) return mem;
    const scoped = await cloudMap.getItem<string>(scopedKey).catch(() => null);
    if (isOwnedObjectKey(scoped, userId)) {
        syncMediaCache.set(scopedKey, scoped);
        return scoped;
    }
    // 兼容历史未分区的 cloud_media_map：只采信 objectKey 前缀确实属于当前 userId 的条目并迁移。
    const legacy = await cloudMap.getItem<string>(localKey).catch(() => null);
    if (isOwnedObjectKey(legacy, userId)) {
        syncMediaCache.set(scopedKey, legacy);
        await cloudMap.setItem(scopedKey, legacy).catch(() => undefined);
        return legacy;
    }
    return null;
}

export async function objectKeyFor(localKey: string): Promise<string | null> {
    const uid = currentCloudUserId();
    if (!uid) return null;
    const cached = await localObjectKeyFor(localKey, uid);
    if (cached) return cached;
    // 本地映射丢了（换设备 / 换浏览器）：问服务端，历史画布的本地键靠这一步找回云端文件。
    const remote = await fetchMediaKeys([localKey]).catch((): Record<string, string> => ({}));
    const objectKey = remote[localKey];
    if (isOwnedObjectKey(objectKey, uid)) {
        await recordObjectKey(localKey, objectKey, uid);
        return objectKey;
    }
    return null;
}

/** 批量按本地键查云端 object_key。只返回当前用户名下登记过的。 */
export async function fetchMediaKeys(localKeys: string[]): Promise<Record<string, string>> {
    if (!localKeys.length) return {};
    const data = await api<{ keys: Record<string, string> }>("POST", "/api/canvas/media/keys", { local_keys: localKeys });
    return data.keys || {};
}

export async function recordObjectKey(localKey: string, objectKey: string, userId = currentCloudUserId()) {
    if (!userId || !localKey || !isOwnedObjectKey(objectKey, userId)) return;
    const scopedKey = mediaMapKey(userId, localKey);
    syncMediaCache.set(scopedKey, objectKey);
    await cloudMap.setItem(scopedKey, objectKey).catch(() => undefined);
}

function normalizeCloudMedia(localKey: string, blob: Blob): { kind: string; mimeType: string } {
    const prefix = localKey.split(":")[0] || "";
    const baseKind =
        prefix === "image"
            ? "image"
            : prefix === "video" || prefix === "video-reference"
              ? "video"
              : prefix === "audio" || prefix === "audio-reference"
                ? "audio"
                : "file";

    let mime = (blob.type || "").split(";")[0].trim().toLowerCase();
    if (mime === "image/jpg") mime = "image/jpeg";
    else if (mime === "audio/mp3") mime = "audio/mpeg";
    else if (mime === "audio/x-wav") mime = "audio/wav";

    if (baseKind === "file") {
        return { kind: "file", mimeType: mime || "application/octet-stream" };
    }
    if (ALLOWED_CANVAS_MIMES[baseKind].has(mime)) {
        return { kind: baseKind, mimeType: mime };
    }
    if (!mime || mime === "application/octet-stream") {
        const fallbackMime = baseKind === "image" ? "image/png" : baseKind === "video" ? "video/mp4" : "audio/mpeg";
        return { kind: baseKind, mimeType: fallbackMime };
    }
    return { kind: "file", mimeType: mime };
}

async function backfillSingleLocalKey(localKey: string, userId: number): Promise<string | null> {
    const flightKey = mediaMapKey(userId, localKey);
    const existing = inflightBackfills.get(flightKey);
    if (existing) return existing;

    const task = (async () => {
        try {
            if (currentCloudUserId() !== userId) return null;
            let blob: Blob | null = null;
            if (localKey.startsWith("image:")) {
                const { getImageBlob } = await import("@/services/image-storage");
                blob = await getImageBlob(localKey);
            } else {
                const { getMediaBlob } = await import("@/services/file-storage");
                blob = await getMediaBlob(localKey);
            }
            if (!blob || blob.size <= 0 || currentCloudUserId() !== userId) return null;
            const { kind, mimeType } = normalizeCloudMedia(localKey, blob);
            const objectKey = await uploadToCloud(blob, kind, mimeType, { local_key: localKey });
            if (!isOwnedObjectKey(objectKey, userId) || currentCloudUserId() !== userId) return null;
            await recordObjectKey(localKey, objectKey, userId);
            return objectKey;
        } catch {
            return null;
        } finally {
            inflightBackfills.delete(flightKey);
        }
    })();

    inflightBackfills.set(flightKey, task);
    return task;
}

/** 对文档中缺失云端映射的本地素材键，从本机 IndexedDB 补传 COS 并登记 local_key。 */
async function backfillLocalStorageKeys(localKeys: string[], userId: number): Promise<Record<string, string>> {
    const unique = [...new Set(localKeys)].filter((k) => Boolean(k) && !k.startsWith("media/") && !k.startsWith("data:"));
    if (!unique.length || currentCloudUserId() !== userId) return {};

    const results: Record<string, string> = {};
    let nextIndex = 0;
    const workers = Math.min(3, unique.length);
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (nextIndex < unique.length) {
                const key = unique[nextIndex++];
                if (currentCloudUserId() !== userId) return;
                const objectKey = await backfillSingleLocalKey(key, userId);
                if (objectKey && isOwnedObjectKey(objectKey, userId)) {
                    results[key] = objectKey;
                }
            }
        }),
    );
    return results;
}

// ===== 画布项目 =====

export async function listCloudProjects(): Promise<CloudProject[]> {
    const data = await api<{ items: CloudProject[] }>("GET", "/api/canvas/projects");
    return data.items || [];
}

export async function getCloudProject(id: string): Promise<CloudProject | null> {
    try {
        const data = await api<{ project: CloudProject }>("GET", `/api/canvas/projects/${id}`);
        return data.project;
    } catch {
        return null;
    }
}

export async function createCloudProject(title: string): Promise<CloudProject> {
    const data = await api<{ project: CloudProject }>("POST", "/api/canvas/projects", { title });
    return data.project;
}

export type SaveProjectResult = { project?: CloudProject; conflict: boolean };

export async function saveCloudProject(id: string, title: string, doc: string, revision: number): Promise<SaveProjectResult> {
    const res = await axios.request({
        method: "PUT",
        url: apiUrl(`/api/canvas/projects/${id}`),
        data: { title, doc, revision },
        requiresAuth: true,
    });
    const payload = res.data as { success?: boolean; message?: string; code?: string; data?: { project?: CloudProject } };
    if (payload.code === "revision_conflict") return { conflict: true, project: payload.data?.project };
    if (payload.success === false) throw new Error(payload.message || "保存失败");
    return { conflict: false, project: payload.data?.project };
}

/** 关页/切走时的 keepalive PUT，防止 1.5s 防抖窗口未 flush 就关闭浏览器丢失最后几笔。 */
export function saveCloudProjectKeepalive(id: string, title: string, doc: string, revision: number): boolean {
    const token = useUserStore.getState().session?.token;
    if (!token) return false;
    const body = JSON.stringify({ title, doc, revision });
    // 浏览器 keepalive 请求体上限通常约 64KB，超限交给普通请求或 localStorage/IndexedDB。
    if (body.length > 60_000) return false;
    try {
        void fetch(apiUrl(`/api/canvas/projects/${id}`), {
            method: "PUT",
            keepalive: true,
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body,
        });
        return true;
    } catch {
        return false;
    }
}

export async function deleteCloudProject(id: string) {
    await api("DELETE", `/api/canvas/projects/${id}`);
}

/**
 * 递归重写任意结构里的 storageKey 字段。
 * storageKey 在本项目的语义是唯一的（媒体本地键 / 云端对象键），
 * 只替换这个字段名，不碰其它内容。
 */
async function rewriteStorageKeys<T>(value: T, mapper: (key: string) => Promise<string>): Promise<T> {
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) out.push(await rewriteStorageKeys(item, mapper));
        return out as T;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) {
            out[k] = k === "storageKey" && typeof v === "string" ? await mapper(v) : await rewriteStorageKeys(v, mapper);
        }
        return out as T;
    }
    return value;
}

/** 收集结构里所有 storageKey（同步）。 */
export function collectStorageKeys(value: unknown, out: Set<string>) {
    if (Array.isArray(value)) {
        for (const item of value) collectStorageKeys(item, out);
        return;
    }
    if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === "storageKey" && typeof v === "string") out.add(v);
            else collectStorageKeys(v, out);
        }
    }
}

/**
 * 把本地画布对象序列化成云端 doc：
 * 1) 查当前账号的本地 cloud_media_map
 * 2) 批量问服务端 /api/canvas/media/keys
 * 3) 对仍无映射的本地键尝试从 IndexedDB 补传 COS 后替换成 objectKey
 */
export async function serializeDoc(project: { [key: string]: unknown }): Promise<string> {
    const uid = currentCloudUserId();
    if (!uid) return JSON.stringify(project);

    const all = new Set<string>();
    collectStorageKeys(project, all);
    const pending = [...all].filter((key) => Boolean(key) && !key.startsWith("media/") && !key.startsWith("data:"));
    const resolved = new Map<string, string>();

    const needRemote: string[] = [];
    for (const key of pending) {
        const local = await localObjectKeyFor(key, uid);
        if (local) resolved.set(key, local);
        else needRemote.push(key);
    }

    if (needRemote.length) {
        const remoteKeys = await fetchMediaKeys(needRemote).catch((): Record<string, string> => ({}));
        for (const key of needRemote) {
            const objKey = remoteKeys[key];
            if (isOwnedObjectKey(objKey, uid)) {
                resolved.set(key, objKey);
                await recordObjectKey(key, objKey, uid);
            }
        }
    }

    const needBackfill = needRemote.filter((key) => !resolved.has(key));
    if (needBackfill.length && currentCloudUserId() === uid) {
        const uploaded = await backfillLocalStorageKeys(needBackfill, uid);
        for (const [key, objKey] of Object.entries(uploaded)) {
            if (isOwnedObjectKey(objKey, uid)) resolved.set(key, objKey);
        }
    }

    const rewritten = await rewriteStorageKeys(project, async (key) => {
        if (!key || key.startsWith("media/") || key.startsWith("data:")) return key;
        return resolved.get(key) || key;
    });
    return JSON.stringify(rewritten);
}

/**
 * 打开或拉取画布时修复云端文档里残留的本地键：
 * 依次尝试服务端 local_key 映射、本地 cloud_media_map、以及从当前浏览器的 IndexedDB 补传 COS。
 * 只有确实改写了至少 1 个本地键才会保存新版本。
 */
export async function repairCloudProjectMediaKeys(cloudProjectId: string, prefetched?: CloudProject | null): Promise<CloudProject | null> {
    const uid = currentCloudUserId();
    if (!uid) return prefetched ?? null;

    const project = prefetched ?? (await getCloudProject(cloudProjectId));
    if (!project || currentCloudUserId() !== uid) return project;
    let doc: unknown;
    try {
        doc = JSON.parse(project.doc || "{}");
    } catch {
        return project;
    }

    const all = new Set<string>();
    collectStorageKeys(doc, all);
    const pending = [...all].filter((key) => Boolean(key) && !key.startsWith("media/") && !key.startsWith("data:"));
    if (!pending.length) return project;

    const resolved = new Map<string, string>();
    const remoteKeys = await fetchMediaKeys(pending).catch((): Record<string, string> => ({}));
    for (const key of pending) {
        const objKey = remoteKeys[key];
        if (isOwnedObjectKey(objKey, uid)) {
            resolved.set(key, objKey);
            await recordObjectKey(key, objKey, uid);
        }
    }

    const needLocal = pending.filter((key) => !resolved.has(key));
    for (const key of needLocal) {
        const local = await localObjectKeyFor(key, uid);
        if (local) resolved.set(key, local);
    }

    const needBackfill = needLocal.filter((key) => !resolved.has(key));
    if (needBackfill.length && currentCloudUserId() === uid) {
        const uploaded = await backfillLocalStorageKeys(needBackfill, uid);
        for (const [key, objKey] of Object.entries(uploaded)) {
            if (isOwnedObjectKey(objKey, uid)) resolved.set(key, objKey);
        }
    }

    if (!resolved.size || currentCloudUserId() !== uid) return project;
    let changed = false;
    const rewritten = await rewriteStorageKeys(doc, async (key) => {
        if (!key || key.startsWith("media/") || key.startsWith("data:")) return key;
        const objectKey = resolved.get(key);
        if (objectKey) {
            changed = true;
            return objectKey;
        }
        return key;
    });
    if (!changed || currentCloudUserId() !== uid) return project;
    const saved = await saveCloudProject(cloudProjectId, project.title, JSON.stringify(rewritten), project.revision);
    return saved.project || project;
}
