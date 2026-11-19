import axios from "axios";

import { readAxiosError } from "./http";

/**
 * 爆款转绘历史：分析结果 + 生成参数 + 素材引用，存在服务端（copy_analyses）。
 * 走 `/api/user/**`，和 copy/analyze 一样只认登录态 token。
 */

export type CopyHistorySummary = {
    id: number;
    title: string;
    doc_bytes: number;
    shot_count: number;
    created_at: number;
    updated_at: number;
};

export type CopyHistoryRecord = CopyHistorySummary & { doc: string };

type Payload = { title: string; doc: string; shot_count: number };

function endpoint(id?: number) {
    return id ? `/api/user/copy/analyses/${id}` : "/api/user/copy/analyses";
}

function headers(token: string) {
    return { Authorization: `Bearer ${token.trim()}` };
}

async function unwrap<T>(request: Promise<{ data: { success?: boolean; message?: string; data?: T } }>, fallback: string): Promise<T> {
    const response = await request.catch((error: unknown) => {
        throw new Error(readAxiosError(error, fallback));
    });
    const body = response.data;
    if (!body?.success) throw new Error(body?.message || fallback);
    return body.data as T;
}

export async function listCopyHistory(token: string, signal?: AbortSignal): Promise<CopyHistorySummary[]> {
    const data = await unwrap<CopyHistorySummary[]>(axios.get(endpoint(), { headers: headers(token), signal, timeout: 15000 }), "读取历史记录失败");
    return Array.isArray(data) ? data : [];
}

export async function getCopyHistory(token: string, id: number, signal?: AbortSignal): Promise<CopyHistoryRecord> {
    return unwrap<CopyHistoryRecord>(axios.get(endpoint(id), { headers: headers(token), signal, timeout: 20000 }), "读取历史记录失败");
}

export async function createCopyHistory(token: string, payload: Payload): Promise<CopyHistoryRecord> {
    return unwrap<CopyHistoryRecord>(axios.post(endpoint(), payload, { headers: headers(token), timeout: 30000 }), "保存历史记录失败");
}

export async function updateCopyHistory(token: string, id: number, payload: Payload): Promise<void> {
    await unwrap<void>(axios.put(endpoint(id), payload, { headers: headers(token), timeout: 30000 }), "保存历史记录失败");
}

export async function deleteCopyHistory(token: string, id: number): Promise<void> {
    await unwrap<void>(axios.delete(endpoint(id), { headers: headers(token), timeout: 15000 }), "删除历史记录失败");
}

export function formatHistoryTime(unixSeconds: number) {
    if (!unixSeconds) return "";
    const date = new Date(unixSeconds * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
