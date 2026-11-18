import axios from "axios";

import { buildApiUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/** 爆款转绘的中间结构：角色/场景/物品 + 分镜。 */
export type CopyItem = {
    id: string;
    name: string;
    description: string;
};

export type CopyShot = {
    id: string;
    start: string;
    end: string;
    description: string;
    roles: string[];
    scenes: string[];
    items: string[];
};

export type CopyAnalysis = {
    title: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    shots: CopyShot[];
};

export type CopyFrame = { time: number; dataUrl: string };

const ANALYSIS_PROMPT = `你是一名专业的短视频分镜分析师。用户会上传一个视频按时间顺序抽取的若干帧（每帧对应一个大致时间点）。
请分析这些画面，输出用于"爆款转绘"的结构化信息，必须严格返回 JSON（不要 markdown 代码块），结构如下：

{
  "title": "一句话概括视频主题",
  "roles": [{ "name": "角色名", "description": "外观、服装、发型、气质等可复用于生图的描述" }],
  "scenes": [{ "name": "场景名", "description": "地点、光线、环境布置等可复用于生图的描述" }],
  "items": [{ "name": "物品名", "description": "外观、材质、颜色等可复用于生图的描述" }],
  "shots": [{
    "start": "0.5秒", "end": "6.7秒",
    "description": "这一镜头的画面内容、人物动作、镜头运动、景别、台词/口播要点",
    "roles": ["该镜头出现的角色名"], "scenes": ["该镜头所在场景名"], "items": ["该镜头出现的关键物品名"]
  }]
}

要求：
1. 角色/场景/物品去重合并，同一对象只出现一次，名称简短。
2. 分镜按时间顺序，尽量覆盖全部帧；start/end 用"X秒"格式。
3. 所有名称必须与 roles/scenes/items 里的 name 完全一致。
4. 只输出 JSON。`;

export function aiTextUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

export function aiTextHeaders(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

/** 浏览器端抽帧：在视频上按等间隔取 N 帧，缩到 1280 长边，返回 JPEG dataURL。 */
export async function extractVideoFrames(file: File, count = 12, signal?: AbortSignal): Promise<CopyFrame[]> {
    const src = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("视频无法解码，请换一个格式（建议 MP4/H.264）"));
            if (signal) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (!duration) throw new Error("视频时长读取失败");
        const maxEdge = 1280;
        const scale = Math.min(1, maxEdge / Math.max(video.videoWidth || maxEdge, video.videoHeight || maxEdge));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((video.videoWidth || maxEdge) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || maxEdge) * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("浏览器不支持 canvas 抽帧");
        const frames: CopyFrame[] = [];
        const total = Math.max(1, Math.min(count, Math.ceil(duration / 1.5)));
        for (let i = 0; i < total; i++) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const time = (duration * (i + 0.5)) / total;
            await new Promise<void>((resolve, reject) => {
                video.onseeked = () => resolve();
                video.onerror = () => reject(new Error("抽帧失败"));
                video.currentTime = Math.min(time, Math.max(0, duration - 0.05));
            });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push({ time, dataUrl: canvas.toDataURL("image/jpeg", 0.72) });
        }
        return frames;
    } finally {
        URL.revokeObjectURL(src);
    }
}

/** 调用多模态模型把帧分析成角色/场景/物品 + 分镜。 */
export async function analyzeVideoFrames(config: AiConfig, frames: CopyFrame[], model: string, signal?: AbortSignal): Promise<CopyAnalysis> {
    // 每帧前面带时间点，模型才能把画面和时间对齐，分镜的 start/end 才有依据。
    const content: unknown[] = [{ type: "text", text: ANALYSIS_PROMPT }];
    frames.forEach((frame, index) => {
        content.push({ type: "text", text: `第 ${index + 1} 帧（≈${Math.round(frame.time)} 秒）：` });
        content.push({ type: "image_url", image_url: { url: frame.dataUrl } });
    });
    // 必须走 resolveModelRequestConfig：登录模式下顶层 config.apiKey 是空的，
    // 真正可用的 key 和 baseUrl 在渠道上（和其他 relay 请求保持一致），否则会 401「无效的令牌」。
    const requestConfig = resolveModelRequestConfig(config, model);
    const response = await axios.post(
        aiTextUrl(requestConfig, "/chat/completions"),
        { model, messages: [{ role: "user", content }], max_tokens: 4000 },
        { headers: aiTextHeaders(requestConfig), signal, timeout: 180000 },
    );
    const text: string = response.data?.choices?.[0]?.message?.content || "";
    const json = extractJson(text);
    return normalizeAnalysis(json, frames);
}

function extractJson(text: string): Record<string, unknown> {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型没有返回可解析的 JSON");
    return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeAnalysis(raw: Record<string, unknown>, frames: CopyFrame[]): CopyAnalysis {
    const stamp = Date.now();
    const toItems = (value: unknown): CopyItem[] =>
        (Array.isArray(value) ? value : [])
            .map((item, index) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const name = String(record.name ?? "").trim();
                if (!name) return null;
                return { id: `item-${stamp}-${index}`, name, description: String(record.description ?? "").trim() };
            })
            .filter((item): item is CopyItem => Boolean(item));
    const toShots = (value: unknown): CopyShot[] =>
        (Array.isArray(value) ? value : [])
            .map((item, index) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
                return {
                    id: `shot-${stamp}-${index}`,
                    start: String(record.start ?? `${Math.round(frames[index]?.time ?? index * 3)}秒`),
                    end: String(record.end ?? `${Math.round(frames[index + 1]?.time ?? (index + 1) * 3)}秒`),
                    description: String(record.description ?? "").trim(),
                    roles: asList(record.roles),
                    scenes: asList(record.scenes),
                    items: asList(record.items),
                };
            })
            .filter((shot) => shot.description || shot.roles.length);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        roles: toItems(raw.roles),
        scenes: toItems(raw.scenes),
        items: toItems(raw.items),
        shots: toShots(raw.shots),
    };
}
