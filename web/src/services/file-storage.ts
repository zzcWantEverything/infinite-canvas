import localforage from "localforage";
import { nanoid } from "nanoid";

import { getCloudMediaUrls, isCloudEnabled, objectKeyFor, recordObjectKey, trackCloudUpload, uploadToCloud } from "@/services/canvas-cloud";
import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input))).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    // 云端同步是 fire-and-forget：本地 blob 已经秒回显，上传在后台进行，失败静默。
    // 但要登记成「进行中的上传」，推送画布文档前会等它落地，否则会存成本地键。
    trackCloudUpload(syncMediaToCloud(storageKey, blob, prefix, meta));
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}


/**
 * 把一份已经存在本地的 blob 补传云端（导入画布时用）。
 * 导入只把素材写进 IndexedDB，不补传的话文档里永远存成本地键，换设备就是空白。
 */
export async function syncStoredBlob(storageKey: string, blob: Blob) {
    const prefix = storageKey.split(":")[0] || "file";
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(URL.createObjectURL(blob)) : {};
    trackCloudUpload(syncMediaToCloud(storageKey, blob, prefix, meta));
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    // 云端对象键：换设备加载后 doc 里的 storageKey 直接就是 objectKey。
    if (storageKey.startsWith("media/")) {
        const urls = (await getCloudMediaUrls([storageKey]).catch(() => null)) ?? {};
        return urls[storageKey] || fallback;
    }
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    }
    // 本地没有 blob：换设备 / 清缓存后，靠 objectKey 换签名地址回放。
    const objectKey = await objectKeyFor(storageKey);
    if (objectKey) {
        const urls = (await getCloudMediaUrls([objectKey]).catch(() => null)) ?? {};
        const url = urls[objectKey];
        if (url) return url;
    }
    return fallback;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function mediaKindFromPrefix(prefix: string) {
    if (prefix === "image") return "image";
    if (prefix === "audio") return "audio";
    if (prefix === "video") return "video";
    return "file";
}

// 上传成功后把 storageKey -> objectKey 的映射落盘，供跨设备回放。
async function syncMediaToCloud(storageKey: string, blob: Blob, prefix: string, meta: { width?: number; height?: number; durationMs?: number }) {
    if (!isCloudEnabled()) return;
    try {
        const objectKey = await uploadToCloud(blob, mediaKindFromPrefix(prefix), blob.type || "application/octet-stream", {
            width: meta.width,
            height: meta.height,
            duration_ms: meta.durationMs,
            local_key: storageKey,
        });
        await recordObjectKey(storageKey, objectKey);
    } catch {
        // 上传失败不打断使用：本地 blob 仍在，下次上传新素材时再补传。
    }
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
