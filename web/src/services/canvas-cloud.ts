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

export async function getCloudMediaUrls(keys: string[]): Promise<Record<string, string>> {
    const data = await api<{ urls: Record<string, string> }>("POST", "/api/canvas/media/urls", { keys });
    return data.urls || {};
}

// ===== 本地 storageKey -> objectKey 映射 =====

export async function objectKeyFor(localKey: string): Promise<string | null> {
    return cloudMap.getItem<string>(localKey).catch(() => null);
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

/** 把本地画布对象序列化成云端 doc：storageKey 有映射就替换成 objectKey。 */
export async function serializeDoc(project: { [key: string]: unknown }): Promise<string> {
    const rewritten = await rewriteStorageKeys(project, async (key) => {
        if (key.startsWith("media/")) return key;
        const objectKey = await objectKeyFor(key);
        return objectKey || key;
    });
    return JSON.stringify(rewritten);
}
