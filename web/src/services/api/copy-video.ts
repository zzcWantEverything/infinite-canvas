import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { requestGeneration } from "@/services/api/image";
import { readAxiosError } from "@/services/api/http";
import { VIDEO_POLL_INTERVAL, createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";

/** 爆款转绘的中间结构：角色/场景/物品 + 分镜。 */
export type CopyItem = {
    id: string;
    name: string;
    description: string;
};

export type CopyShot = {
    id: string;
    /** 时间码，精确到 0.1 秒 */
    start: string;
    end: string;
    duration: string;
    /** 景别：特写 / 近景 / 中景 / 全景 / 远景 */
    shotSize: string;
    /** 机位与角度 */
    cameraAngle: string;
    /** 镜头运动：固定 / 推 / 拉 / 摇 / 移 / 跟 / 手持 */
    cameraMove: string;
    /** 画面：首帧内容、人物位置朝向、手持物、前后景物件、结束动作停在何处 */
    description: string;
    /** 表演：动作顺序、视线落点、手势、呼吸停顿、表情变化、动作落在哪个词上 */
    performance: string;
    /** 声音：口播/对白（人物名）、画外旁白、环境声、操作音效，含说话人与起止 */
    sound: string;
    /** 台词原文（来自音轨转写，没有则为空） */
    dialogue: string;
    /** 画面文字：口播字幕 / 活动价签 / 身份条 / 招牌 / 包装，含位置与时间 */
    onScreenText: string;
    roles: string[];
    scenes: string[];
    items: string[];
};

export type CopyAnalysis = {
    title: string;
    /** 画面比例，如 9:16 */
    ratio: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    shots: CopyShot[];
};

export type CopyFrame = { time: number; dataUrl: string };

/** 前端抽帧的硬上限：超过 10 分钟 seek 次数太多，体验不可接受。 */
export const MAX_VIDEO_SECONDS = 600;

export type CopyVideoMeta = {
    duration: number;
    width: number;
    height: number;
    frameCount: number;
    sceneCount: number;
};

function analysisPrompt(meta: CopyVideoMeta) {
    return `你是一名专业的短视频逐镜拆解师，要产出一份可直接用于 AI 视频生成与剪辑复刻的逐镜脚本。
用户会给出：视频宫格图（每格标了序号和大致时间点）、元数据、以及音轨自动转写的台词。

视频元数据：
- 时长：${meta.duration.toFixed(1)} 秒
- 分辨率：${meta.width}x${meta.height}
- 抽帧：${meta.frameCount} 格（已按画面差异挑选，共 ${meta.sceneCount} 个场景切换）

拆解规则：
1. 按原片切点逐镜拆解：每次硬切、机位变化或明显转场都单独编号；极短的产品特写、手部动作、人物反应镜头也要保留。
   时间码精确到 0.1 秒。跨度长时每 30 秒为一组（用 group 字段标组号，从 1 开始），最后一组按实际时长。
   跨组镜头保留原切点和连续动作，台词只录一次。
2. 声音区分四类：人物口播/对白（写明是谁、对镜还是对台下/对人说）、画外旁白（标明覆盖哪些镜头）、环境声、操作音效。
   同一句跨多镜头只写一次，并注明切在第几个词。听不清写「待核对」，不要补写；说话人无法确认标「说话人待确认」。
3. 画面里出现的数字/价签只写在画面/画面文字字段；只有实际说出的内容才进口播或旁白，两者不要混。
4. 品牌、包装、价格、数量、原话按原片记录，不要改写或替换。
5. 角色/场景/物品去重合并，名称简短；分镜里的名称必须与 roles/scenes/items 的 name 完全一致。

严格返回 JSON（不要 markdown 代码块）：
{
  "title": "一句话概括视频主题",
  "ratio": "画面比例，如 9:16",
  "roles": [{ "name": "角色名", "description": "外观、服装、发型、气质等可复用于生图的描述" }],
  "scenes": [{ "name": "场景名", "description": "地点、光线、环境布置等可复用于生图的描述" }],
  "items": [{ "name": "物品名", "description": "外观、材质、颜色等可复用于生图的描述" }],
  "shots": [{
    "group": 1,
    "start": "0.0秒",
    "end": "2.3秒",
    "duration": "2.3秒",
    "shotSize": "特写/近景/中景/全景/远景",
    "cameraAngle": "平视/俯拍/仰拍/正面/侧面/过肩等，含机位高低",
    "cameraMove": "固定/推/拉/摇/移/跟/手持",
    "description": "画面：第一帧是什么，人物在画面左/中/右哪个位置、身体朝哪、谁拿着什么、前景和背景有哪些物件，镜头结束时动作停在哪里",
    "performance": "表演：具体动作及发生顺序，视线落点、手势、呼吸停顿、表情变化，哪个动作落在哪个词上",
    "sound": "声音：🔵【人物口播／对白｜人物名】或 🟠【画外旁白｜声线归属】，以及环境声、操作音效，含说话人与起止位置",
    "dialogue": "该镜头对应的台词/口播原文（没有则为空字符串）",
    "onScreenText": "画面文字：口播字幕/活动价签/人物身份条/背景招牌/产品包装，记录内容、位置与出现时间（没有则为空字符串）",
    "roles": ["该镜头出现的角色名"],
    "scenes": ["该镜头所在场景名"],
    "items": ["该镜头出现的关键物品名"]
  }]
}


要求：
1. 角色/场景/物品去重合并，同一对象只出现一次，名称简短。
2. 分镜按时间顺序，尽量覆盖全部格；每个场景切换至少要有一个分镜。
3. 所有名称必须与 roles/scenes/items 里的 name 完全一致。
4. 只输出 JSON。`;
}

export function aiTextUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

export function aiTextHeaders(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

/**
 * 场景检测抽帧：按固定步长采样小缩略图，和上一张比较像素差异，
 * 差异超过阈值就判定为「镜头切换」，保留该时刻的高清帧；再均匀补齐到 maxFrames。
 * 相比固定间隔抽帧，关键镜头不容易漏，重复帧也不会占满额度。
 */
export async function extractSceneFrames(file: File, maxFrames = 32, signal?: AbortSignal): Promise<{ frames: CopyFrame[]; meta: CopyVideoMeta }> {
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
        if (duration > MAX_VIDEO_SECONDS) throw new Error(`视频不能超过 ${MAX_VIDEO_SECONDS / 60} 分钟（当前 ${(duration / 60).toFixed(1)} 分钟）`);
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        if (!width || !height) throw new Error("视频分辨率读取失败");

        const thumb = document.createElement("canvas");
        thumb.width = 64;
        thumb.height = 36;
        const thumbCtx = thumb.getContext("2d", { willReadFrequently: true });
        const fullMaxEdge = 640;
        const scale = Math.min(1, fullMaxEdge / Math.max(width, height));
        const full = document.createElement("canvas");
        full.width = Math.max(1, Math.round(width * scale));
        full.height = Math.max(1, Math.round(height * scale));
        const fullCtx = full.getContext("2d");
        if (!thumbCtx || !fullCtx) throw new Error("浏览器不支持 canvas 抽帧");

        const seek = (time: number) =>
            new Promise<void>((resolve, reject) => {
                video.onseeked = () => resolve();
                video.onerror = () => reject(new Error("抽帧失败"));
                video.currentTime = Math.min(Math.max(time, 0), Math.max(0, duration - 0.05));
            });

        // 动态步长：短视频抓得细，长视频降采样，保证 seek 次数可控（10 分钟内最多约 600 次）
        const step = duration <= 60 ? 0.4 : duration <= 300 ? 1 : 2;
        let previous: Uint8ClampedArray | null = null;
        const candidates: { time: number; diff: number; dataUrl: string }[] = [];
        for (let t = 0; t < duration; t += step) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await seek(t);
            thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
            const pixels = thumbCtx.getImageData(0, 0, thumb.width, thumb.height).data;
            let diff = 0;
            if (previous) {
                for (let i = 0; i < pixels.length; i += 4) {
                    diff += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
                }
                diff /= (pixels.length / 4) * 3 * 255;
            }
            previous = new Uint8ClampedArray(pixels);
            fullCtx.drawImage(video, 0, 0, full.width, full.height);
            candidates.push({ time: t, diff, dataUrl: full.toDataURL("image/jpeg", 0.78) });
        }

        // 先按差异找「镜头切换」作为场景边界，再在每个场景内均匀多抽几帧，
        // 这样同一个场景里的动作推进也能被看到，而不是每个场景只有一张定格。
        const threshold = 0.06;
        const sceneChanges = candidates.filter((item, index) => index === 0 || item.diff >= threshold);
        const framesPerScene = 4;
        const picked: typeof candidates = [];
        for (let i = 0; i < sceneChanges.length; i++) {
            const startTime = sceneChanges[i].time;
            const endTime = i + 1 < sceneChanges.length ? sceneChanges[i + 1].time : duration;
            const span = Math.max(endTime - startTime, 0.01);
            for (let j = 0; j < framesPerScene; j++) {
                const target = startTime + (span * (j + 0.5)) / framesPerScene;
                // 取离目标时间最近的候选帧
                let closest = candidates[0];
                let closestDelta = Math.abs(candidates[0].time - target);
                for (const candidate of candidates) {
                    const delta = Math.abs(candidate.time - target);
                    if (delta < closestDelta) {
                        closest = candidate;
                        closestDelta = delta;
                    }
                }
                picked.push(closest);
            }
        }
        // 超出上限时按时间均匀抽，避免请求过大
        let finalPicked = picked;
        if (picked.length > maxFrames) {
            const sorted = [...picked].sort((a, b) => a.time - b.time);
            finalPicked = Array.from({ length: maxFrames }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (maxFrames - 1))]);
        }
        const unique = Array.from(new Map(finalPicked.map((item) => [item.time, item])).values()).sort((a, b) => a.time - b.time);

        return {
            frames: unique.map((item) => ({ time: item.time, dataUrl: item.dataUrl })),
            meta: { duration, width, height, frameCount: unique.length, sceneCount: sceneChanges.length },
        };
    } finally {
        URL.revokeObjectURL(src);
    }
}

/** 把关键帧拼成宫格图（每格带序号和时间），一次请求就能让模型看到整条时间线。 */
export async function buildFrameGrid(frames: CopyFrame[], cols = 4): Promise<string> {
    const cellWidth = 200;
    const cellHeight = 112;
    const labelHeight = 18;
    const rows = Math.ceil(frames.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * cols;
    canvas.height = (cellHeight + labelHeight) * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 canvas 拼图");
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // dataURL 的 Image 必须等 onload 才能可靠 drawImage
    const images = await Promise.all(
        frames.map(
            (frame) =>
                new Promise<HTMLImageElement>((resolve) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () => resolve(image);
                    image.src = frame.dataUrl;
                }),
        ),
    );
    frames.forEach((frame, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = col * cellWidth;
        const y = row * (cellHeight + labelHeight);
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(x, y + labelHeight, cellWidth, cellHeight);
        if (images[index]?.complete) ctx.drawImage(images[index], x, y + labelHeight, cellWidth, cellHeight);
        ctx.fillStyle = "rgba(17,24,39,0.9)";
        ctx.fillRect(x, y, cellWidth, labelHeight);
        ctx.fillStyle = "#f9fafb";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`#${index + 1}  ${frame.time.toFixed(1)}s`, x + 6, y + labelHeight / 2);
    });
    return canvas.toDataURL("image/jpeg", 0.82);
}

/** 调用多模态模型分析宫格图。sessionToken 必须是后台登录态 token（不是中转 key）。 */
export async function analyzeVideoGrid(config: AiConfig, gridDataUrl: string, meta: CopyVideoMeta, model: string, sessionToken: string, transcript = "", signal?: AbortSignal): Promise<CopyAnalysis> {
    const promptText = transcript
        ? `${analysisPrompt(meta)}\n\n附：视频音轨自动转写的台词（带时间戳，可直接用于分镜的口播/台词字段，注意校正同音字）\n${transcript}`
        : analysisPrompt(meta);
    if (!sessionToken.trim()) throw new Error("请先登录后再分析");
    // 走异步任务：长请求会被链路中间代理 120s 掐断，改成「提交 + 轮询」。
    // 用同源相对路径：`/api/user/**` 挂的是 UserAuth，只认后台登录态 token；
    // 渠道里那个中转 key（sk-...）会被判成「access token 无效」。
    // key 和 baseUrl 都不再上传 —— 服务端按登录用户自己取令牌、地址固定本机回环，
    // 既不让凭证出现在请求体里，也避免 baseUrl 被拿去打内网（SSRF）。
    const endpoint = "/api/user/copy/analyze";
    const headers = { Authorization: `Bearer ${sessionToken.trim()}` };
    // 把后端的中文 message（如「access token 无效」）透出来，别只显示 HTTP 401。
    const submit = await axios.post(endpoint, { model, prompt: promptText, image: gridDataUrl }, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
        throw new Error(readAxiosError(error, "提交分析任务失败"));
    });
    const jobId = String((submit.data as { jobId?: string })?.jobId || "");
    if (!jobId) throw new Error("提交分析任务失败");
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await axios.get(`${endpoint}/${encodeURIComponent(jobId)}`, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
            throw new Error(readAxiosError(error, "查询分析进度失败"));
        });
        const data = poll.data as { status?: string; content?: string; error?: string };
        if (data.status === "done") {
            return normalizeAnalysis(extractJson(String(data.content || "")));
        }
        if (data.status === "failed") throw new Error(data.error || "分析失败");
    }
}


function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const idx = result.indexOf("base64,");
            resolve(idx >= 0 ? result.slice(idx + 7) : result);
        };
        reader.onerror = () => reject(new Error("音频读取失败"));
        reader.readAsDataURL(blob);
    });
}

/** whisper 只吃 16kHz 单声道 PCM；这里把视频文件的音轨解出来并重采样。 */
export async function extractAudioWav(file: File, signal?: AbortSignal): Promise<{ blob: Blob; duration: number } | null> {
    const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    const ctx = new AudioCtor();
    try {
        const buffer = await file.arrayBuffer();
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const decoded = await ctx.decodeAudioData(buffer);
        if (!decoded || decoded.duration <= 0) return null;
        const targetRate = 16000;
        const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
        const offline = new OfflineAudioContext(1, frames, targetRate);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        return { blob: encodeWav(rendered.getChannelData(0), targetRate), duration: decoded.duration };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return null;
    } finally {
        void ctx.close();
    }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
}

/** 调 new-api 的腾讯云 ASR 代理，把音轨转成台词。失败返回空串（降级为无台词）。 */
export async function transcribeAudio(baseUrl: string, sessionToken: string, wav: Blob, signal?: AbortSignal): Promise<string> {
    const audio = await blobToBase64(wav);
    if (!audio) return "";
    const endpoint = `${baseUrl.trim().replace(/\/+$/, "")}/api/user/copy/transcribe`;
    const response = await axios.post(endpoint, { audio }, { headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" }, signal, timeout: 240000 });
    const data = response.data as { success?: boolean; text?: string; message?: string };
    if (!data?.success) return "";
    return String(data.text || "").trim();
}

/** 角色/场景/物品 → 生成一张参考图（返回 dataUrl 或图片 URL）。 */
export async function generateItemImage(config: AiConfig, item: CopyItem, signal?: AbortSignal): Promise<string> {
    const prompt = [item.name, item.description].filter(Boolean).join("，");
    const images = await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜 → 生成一段视频（首帧参考图可选），返回已入库的素材（url + storageKey）。 */
export async function generateShotVideo(
    config: AiConfig,
    shot: CopyShot,
    references: ReferenceImage[] = [],
    signal?: AbortSignal,
): Promise<UploadedFile> {
    const prompt = shotPrompt(shot);
    const task = await createVideoGenerationTask(config, prompt, references, { signal });
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task);
        if (state.status === "completed") {
            return storeGeneratedVideo(state.result);
        }
        if (state.status === "failed") throw new Error(state.error || "视频生成失败");
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL));
    }
}

/**
 * 分镜 → 视频提示词。按「镜头语言 → 画面 → 表演 → 台词/画面文字」拼，
 * 景别/机位/运动单独成句，避免和画面描述混在一起被模型忽略。
 */
export function shotPrompt(shot: CopyShot): string {
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const lines = [camera ? `镜头：${camera}` : "", shot.description ? `画面：${shot.description}` : "", shot.performance ? `表演：${shot.performance}` : "", shot.dialogue ? `台词：${shot.dialogue}` : "", shot.onScreenText ? `画面文字：${shot.onScreenText}` : ""];
    const prompt = lines.filter(Boolean).join("\n");
    return prompt || shot.description || "复刻原片镜头的画面与运镜";
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

function normalizeAnalysis(raw: Record<string, unknown>): CopyAnalysis {
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
                const text = (key: string) => String(record[key] ?? "").trim();
                return {
                    id: `shot-${stamp}-${index}`,
                    start: text("start"),
                    end: text("end"),
                    duration: text("duration"),
                    shotSize: text("shotSize"),
                    cameraAngle: text("cameraAngle"),
                    cameraMove: text("cameraMove"),
                    description: text("description"),
                    performance: text("performance"),
                    sound: text("sound"),
                    dialogue: text("dialogue"),
                    onScreenText: text("onScreenText"),
                    roles: asList(record.roles),
                    scenes: asList(record.scenes),
                    items: asList(record.items),
                };
            })
            .filter((shot) => shot.description || shot.roles.length);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        roles: toItems(raw.roles),
        scenes: toItems(raw.scenes),
        items: toItems(raw.items),
        shots: toShots(raw.shots),
    };
}
