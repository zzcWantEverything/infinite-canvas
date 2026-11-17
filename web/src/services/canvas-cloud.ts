import axios from "axios";
import localforage from "localforage";

import { useUserStore } from "@/stores/use-user-store";

/**
 * 画布持久化的云端能力（new-api 的 /api/canvas/* + COS 直传）。
 *
 * 存储约定：
 * - 本地 storageKey（video:xxx / image:xxx）只作本地 IndexedDB 缓存键；
 * - 上传成功后映射到 COS objectKey（media/{uid}/...），映射存 cloud_media_map；
 * - 画布 doc 推送到云端时，把 storageKey 替换成 objectKey；拉回时字段仍是
 *   objectKey，渲染层按 "media/" 前缀识别并换签名地址。
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
    /** 本地上传键（video:xxx）。登记到服务端后，换设备也能把历史文档里的本地键对回云端文件。 */
    local_key?: string;
};

const cloudMap = localforage.createInstance({ name: "infinite-canvas", storeName: "cloud_media_map" });

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

export async function getCloudMediaUrls(keys: string[]): Promise<Record<string, string>> {
    const data = await api<{ urls: Record<string, string> }>("POST", "/api/canvas/media/urls", { keys });
    return data.urls || {};
}

// ===== 本地 storageKey -> objectKey 映射 =====

async function localObjectKeyFor(localKey: string): Promise<string | null> {
    return cloudMap.getItem<string>(localKey).catch(() => null);
}

export async function objectKeyFor(localKey: string): Promise<string | null> {
    const cached = await localObjectKeyFor(localKey);
    if (cached) return cached;
    // 本地映射丢了（换设备 / 换浏览器）：问服务端，历史画布的本地键靠这一步找回云端文件。
    const remote = await fetchMediaKeys([localKey]).catch((): Record<string, string> => ({}));
    const objectKey = remote[localKey] || null;
    if (objectKey) await cloudMap.setItem(localKey, objectKey).catch(() => undefined);
    return objectKey;
}

/** 批量按本地键查云端 object_key。只返回当前用户名下登记过的。 */
export async function fetchMediaKeys(localKeys: string[]): Promise<Record<string, string>> {
    if (!localKeys.length) return {};
    const data = await api<{ keys: Record<string, string> }>("POST", "/api/canvas/media/keys", { local_keys: localKeys });
    return data.keys || {};
}

export async function recordObjectKey(localKey: string, objectKey: string) {
    await cloudMap.setItem(localKey, objectKey).catch(() => undefined);
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
function collectStorageKeys(value: unknown, out: Set<string>) {
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
 * 把本地画布对象序列化成云端 doc：storageKey 有映射就替换成 objectKey。
 * 先收集所有本地键、批量问服务端一次（换设备时本地映射为空，靠服务端兜底），
 * 避免每个 storageKey 都打一次接口。
 */
export async function serializeDoc(project: { [key: string]: unknown }): Promise<string> {
    const all = new Set<string>();
    collectStorageKeys(project, all);
    const pending = [...all].filter((key) => !key.startsWith("media/") && !key.startsWith("data:"));
    const remoteKeys = await fetchMediaKeys(pending).catch((): Record<string, string> => ({}));
    const rewritten = await rewriteStorageKeys(project, async (key) => {
        if (key.startsWith("media/") || key.startsWith("data:")) return key;
        const objectKey = (await localObjectKeyFor(key)) || remoteKeys[key];
        if (objectKey) await cloudMap.setItem(key, objectKey).catch(() => undefined);
        return objectKey || key;
    });
    return JSON.stringify(rewritten);
}

/**
 * 打开画布时修复云端文档里残留的本地键：历史文档存的是 video:xxx / image:xxx，
 * 换设备后靠服务端映射把它们改写成 object_key 并重推，文档从此不再依赖本地映射。
 * 返回是否真的改写了。
 */
export async function repairCloudProjectMediaKeys(cloudProjectId: string): Promise<boolean> {
    const project = await getCloudProject(cloudProjectId);
    if (!project) return false;
    let doc: unknown;
    try {
        doc = JSON.parse(project.doc || "{}");
    } catch {
        return false;
    }
    const all = new Set<string>();
    collectStorageKeys(doc, all);
    const pending = [...all].filter((key) => !key.startsWith("media/") && !key.startsWith("data:"));
    if (!pending.length) return false;
    const remoteKeys = await fetchMediaKeys(pending).catch((): Record<string, string> => ({}));
    // 原浏览器首次修复时，服务端还没登记 local_key（历史数据），本地 cloud_media_map 才是有的那份，优先用它。
    for (const key of pending) {
        if (remoteKeys[key]) continue;
        const local = await localObjectKeyFor(key);
        if (local) remoteKeys[key] = local;
    }
    if (!Object.keys(remoteKeys).length) return false;
    let changed = false;
    const rewritten = await rewriteStorageKeys(doc, async (key) => {
        if (key.startsWith("media/") || key.startsWith("data:")) return key;
        const objectKey = remoteKeys[key];
        if (objectKey) {
            changed = true;
            return objectKey;
        }
        return key;
    });
    if (!changed) return false;
    await saveCloudProject(cloudProjectId, project.title, JSON.stringify(rewritten), project.revision);
    return true;
}
