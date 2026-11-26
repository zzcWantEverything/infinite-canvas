import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { readAxiosError } from "@/services/api/http";
import { VIDEO_POLL_INTERVAL, createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";

/** 爆款转绘的中间结构：角色/场景/物品 + 分镜。 */
export type CopyItem = {
    id: string;
    name: string;
    description: string;
    /** 角色声线设定（性别、声音年龄、音色、语言/方言、基础语速），只给角色用 */
    voice?: string;
};

export type CopyShot = {
    id: string;
    /** 时间码，精确到 0.1 秒 */
    start: string;
    end: string;
    duration: string;
    /** 可直接出片的视频提示词：整段范围 + 逐节拍时间线（分析产物，可编辑） */
    videoPrompt: string;
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
    /** 屏幕主体文字/花字：大字标题 / 重点花字 / 弹窗关键词 / 价签 / 身份条 / 招牌 / 包装（含文案、字体样式、位置、动效与时间；不含底部口播字幕） */
    onScreenText: string;
    /** 生成该镜首帧用的图片描述词（可编辑，批量「生成图片描述词」写入） */
    imagePrompt: string;
    roles: string[];
    scenes: string[];
    items: string[];
};

export type CopyAnalysis = {
    title: string;
    /** 画面比例，如 9:16 */
    ratio: string;
    /** 全片统一的画风/影调/质感描述，生图与生视频都会带上 */
    style: string;
    /** 全片多子场景共享的统一空间母设定（如同一展厅/住宅的装修风格、灯光色温、材质体系；无则为空） */
    spaceContext?: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    shots: CopyShot[];
};

export type CopyFrame = { time: number; dataUrl: string; /** 所属场景（镜头）序号，分批分析时用来保证一批不跨太多镜头 */ scene: number };


/** 16 档 RGB 直方图（48 个 bin），对摇镜、曝光漂移不敏感。 */
const HIST_BINS = 16;

function frameHistogram(pixels: Uint8ClampedArray, out: Float32Array) {
    out.fill(0);
    const total = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
        out[pixels[i] >> 4] += 1;
        out[HIST_BINS + (pixels[i + 1] >> 4)] += 1;
        out[HIST_BINS * 2 + (pixels[i + 2] >> 4)] += 1;
    }
    const scale = 1 / (total * 3);
    for (let i = 0; i < out.length; i += 1) out[i] *= scale;
    return out;
}

function histogramDistance(a: Float32Array, b: Float32Array) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
    return sum / 2;
}

type FrameSample = { time: number; pixelDiff: number; histDiff: number; dataUrl: string };

/**
 * 切点判定（双阈值 + 渐变检测）：
 * - 硬切：瞬时跳变大（像素差 ≥0.10 或直方图差 ≥0.30）→ 立刻切
 * - 叠化/淡入淡出：画面是渐变的，单帧跳变很小，靠「连续 ≥3 个软信号 + 累积量够大」判定，
 *   在整段渐变的中间切一刀。之前只看固定阈值 0.06，叠化会被整段并成一个镜头。
 */
function detectSceneStarts(candidates: FrameSample[]) {
    const HARD_PIXEL = 0.1;
    const HARD_HIST = 0.3;
    const SOFT_PIXEL = 0.035;
    const SOFT_HIST = 0.1;
    const hard = (d: FrameSample) => d.pixelDiff >= HARD_PIXEL || d.histDiff >= HARD_HIST;
    const soft = (d: FrameSample) => d.pixelDiff >= SOFT_PIXEL || d.histDiff >= SOFT_HIST;

    const cuts = new Set<number>([0]);
    for (let i = 1; i < candidates.length; i += 1) {
        if (hard(candidates[i])) cuts.add(i);
    }
    // 渐变段：连续软信号但都不够硬，累积变化够大就当一次转场
    let runStart = -1;
    for (let i = 1; i <= candidates.length; i += 1) {
        const isSoft = i < candidates.length && soft(candidates[i]) && !hard(candidates[i]);
        if (isSoft && runStart < 0) runStart = i;
        if (!isSoft && runStart >= 0) {
            const span = i - runStart;
            let pixelSum = 0;
            let histSum = 0;
            for (let j = runStart; j < i; j += 1) {
                pixelSum += candidates[j].pixelDiff;
                histSum += candidates[j].histDiff;
            }
            if (span >= 3 && (pixelSum >= HARD_PIXEL * 1.5 || histSum >= HARD_HIST * 1.2)) {
                cuts.add(runStart + Math.floor(span / 2));
            }
            runStart = -1;
        }
    }
    return [...cuts].sort((a, b) => a - b).map((index) => candidates[index]);
}

/** 前端抽帧的硬上限：超过 10 分钟 seek 次数太多，体验不可接受。 */
export const MAX_VIDEO_SECONDS = 600;

export type CopyVideoMeta = {
    duration: number;
    width: number;
    height: number;
    frameCount: number;
    sceneCount: number;
    /** 检测到的切点时间（秒），提示词里给模型当分镜边界参考 */
    cuts?: number[];
};

export type CopyOutlineUnit = { start: string; end: string; summary: string; roles: string[]; scenes: string[]; items: string[] };

/** 第一步（全局）的产物：资产表 + 分镜大纲 + 全片风格。第二步每个时间窗都以它为「已锁定资产」。 */
export type CopyOverview = {
    title: string;
    ratio: string;
    style: string;
    /** 全片多子场景共享的统一空间母设定（没有则为空） */
    spaceContext: string;
    /** 全片屏幕花字/标题文字的统一视觉风格（不含底部口播字幕；没有则为空） */
    textStyle: string;
    roles: CopyItem[];
    scenes: CopyItem[];
    items: CopyItem[];
    outline: CopyOutlineUnit[];
};

export type CopyWindowContext = {
    index: number;
    total: number;
    startTime: number;
    endTime: number;
    /** 本窗范围内的切点时间（秒） */
    cuts?: number[];
    /** 第一步锁定的资产表 */
    casting: { roles: CopyItem[]; scenes: CopyItem[]; items: CopyItem[] };
    /** 本窗内的台词（带时间戳，原样使用） */
    transcript: string;
    /** 第一步大纲里落在这个窗的剧情摘要，给模型当上下文 */
    outline?: string;
    /** 第一步提取的全片统一空间母设定 */
    spaceContext?: string;
    /** 第一步提取的全片屏幕花字/标题文字风格（用于跨窗保持字体/配色/动效一致） */
    textStyle?: string;
    /** 上一窗最后一个单元所在场景名（用于判断同场景连续承接或跨场景硬切） */
    previousScene?: string;
    /** 本窗前已经说过的台词，用来避免同一句被写两遍 */
    previousDialogue?: string;
    /** 上一窗最后一个单元的收尾状态，用来做连续性 */
    previousEndState?: string;
};

export type CopyTimeWindow = { start: number; end: number; frames: CopyFrame[] };

export type CopyAssetKind = "role" | "scene" | "item";
export type CopyAssetSection = "roles" | "scenes" | "items";

export type CopyResolvedAsset = {
    id: string;
    name: string;
    description: string;
    kind: CopyAssetKind;
    section: CopyAssetSection;
};

export type ShotReferenceBinding = {
    /** 1-based，对应实际上传给视频模型的参考图顺序（图片1、图片2...） */
    index: number;
    name: string;
    kind: "storyboard" | CopyAssetKind;
    /** 资产 id 或 frame-<shotId> */
    id?: string;
};

export type PromptAssetToken = { type: "text"; value: string } | { type: "mention"; name: string; raw: string };

export type ShotPromptContext = {
    /** 角色资产表（用于按本镜角色自动注入声线锁定） */
    roles?: CopyItem[];
    /** 全片统一空间母设定 */
    spaceContext?: string;
    /** 实际上传给视频模型的参考图顺序（用于把 @资产 映射为 图片1/图片2...） */
    referenceBindings?: ShotReferenceBinding[];
};

/** 切点列表转成提示词里的短串：太多就折叠，避免把提示词撑长。 */
function formatCuts(cuts: number[] | undefined, max = 40) {
    if (!cuts || !cuts.length) return "";
    const list = cuts.slice(0, max).map((time) => `${time.toFixed(1)}s`);
    if (cuts.length > max) list.push(`等共 ${cuts.length} 处`);
    return list.join("、");
}

const castingLine = (items: CopyItem[]) => items.map((item) => `${item.name}（${item.description || "无描述"}${item.voice ? `；声线：${item.voice}` : ""}）`).join("、");

/** 导演规则：从《AI影视动态分镜生成系统 V2.0》收敛成模型能直接执行的一段。 */
const directingRules = `【导演规则】
1. 单元与节拍：一条分镜=一次视频生成任务出片的单位，5~15 秒；对白密集 5~8 秒，动作/空镜可 10~15 秒。
   原片里的硬切、反打、推拉、台词切换都写进同一单元的节拍里，不要一个切点开一个单元。
   先按台词实际发音时长、呼吸停顿和表演需要定节拍，再让各节拍首尾相接、不重叠、不留空档，总和必须等于单元时长。
   台词不得删减、改写、重复；一句话跨节拍时只写一次，后续节拍写「承接上一拍」。
2. 资产绑定：正文一律用 @资产名 引用，名称与资产表完全一致；已绑定资产不得重新设计五官、年龄、体型、发型、服装与道具外观；禁止凭空增加不存在的人物、场景、道具。
3. 摄影与构图留白：写清景别、机位高度（如站姿约 1.45m / 坐姿视线齐平约 1.2m / 俯拍）、拍摄角度、等效焦段感（如 24~28mm 广角纵深 / 35~50mm 标准写实 / 65~70mm 浅景深特写）、对焦主体、前景遮挡与运动视差（如借前景桌面/家具产生空间视差）、背景光学虚化及构图；运动写起始位置、方向、速度、轨迹与停留点；遵守 180° 轴线、视线匹配、动作匹配。当节拍出现屏幕花字、多行流程列表或 UI 浮窗贴片时，必须明确写清人物的偏移站位与为文字预留的干净留白区（如人物偏中下留出头顶灰墙、人物偏右留出左侧大面积留白），避免文字压脸。
4. 表演与词眼同步：按「心理动机→眼神落点→微表情→呼吸→身体重心→肢体动作→情绪结果」写；必须把关键手势、表情、点头、前倾精准绑定到具体台词关键词上（如说到某词时抬手/翻腕/伸食指强调）；连续列举多项时手势自然微调、不机械重复；说完台词后自然收势停顿，不继续空张嘴；倾听者有真实且带时间差的反应，不抢戏。
5. 声音、声线锁定与全节拍音效：每个声音事件标注类型——DIALOGUE（现场对白）/ NARRATION（画外旁白）/ INNER_MONOLOGUE（内心独白）/ OFFSCREEN_DIALOGUE（画外对白）/ DEVICE_VOICE（电话广播等设备声）/ ENVIRONMENT（环境声）/ SFX（动作音效）/ SILENT（纯表演）。
   口型权限只给实际说话者，其他人不得跟读张嘴；当镜头切至手部、道具、柜体等局部特写但同一人物仍在连续说话时，仍标 DIALOGUE（延续同一人物现场口播与声线），严禁改判为画外旁白 NARRATION 或切换声线；每句台词简明标注语速变化、重读词、句尾升降调与情绪转折（如「语速略快、‘真的’重读、句尾上扬」）。
   无论本节拍有无台词，都必须同步写出真实脚步声、衣物摩擦声、手触物体声、界面滑入声、文字弹出声、认知反转低频强调音等 SFX/ENVIRONMENT，并注明「音效音量低于人物口播、不盖过人声」；未指定不加背景音乐，画面底部不加口播字幕。
6. 连续性与硬切区分：同一场景内延续上一拍或上一单元时，无缝承接站位、姿态、朝向、步伐、运镜方向与语流；切换到新场景时必须明确写「硬切至 @新场景名」并交代新场景初始站位，同时保持人物外观与声音一致；人物脚下有真实接触阴影，背景与建筑结构不漂移，无无关路人出镜。
7. 画面质感：统一光源方向、色温、曝光、接触阴影；不做塑料感、磨皮、悬浮、畸形。
8. 屏幕文字、复杂花字序列与 UI 浮窗贴片（严禁底部口播字幕）：
   必须严格区分两类文字——
   (a) 忽略并严禁复刻：位于画面最下方（底部约 15%~20% 区域）、随台词逐句同步滚动的常规小号口播字幕条（含双语字幕、平台自动字幕）。不得复刻，不得写入 videoPrompt 的画面文字或 onScreenText（仅在没有可用音轨转写时可用于辅助核对台词）。
   (b) 必须分析并复刻：出现在画面主体区域（画面上方、中上部、居中、人物头顶、两侧留白区等非底部字幕区）的重点大字、综艺花字、提问标题、连续弹字、流程列表、活动价签、身份条、实景招牌/包装及屏幕 UI 浮窗贴片。
   凡某节拍出现 (b) 类元素，必须区分以下四种编排模式并在对应节拍的 videoPrompt 中写清：
   - 单组弹出：精确文案（保留引号、标点与分行）、字体粗细/主色重点色/描边投影/立体字效果、屏幕位置与出场动效（如横向动态模糊残影扫入冲击、缩放弹跳）及时间；
   - 替换式连弹：连续多个关键词依次弹出时，写明逐词触发时机与前词缩小/淡出退场方式（如“问问价格？”→“看看板材？”→“比比环保？”）；
   - 累积列表/并排标签：多条关键词或圆角标签依次弹出且已出现的保留在原位形成完整纵向列表或并排排列，写清逐项出现与最后整体退场时机；
   - 屏幕 UI 浮窗/贴片：如角落滑入的手机短视频界面、卡片浮层，写清画面位置、内部展示内容与滑入/退出动效及时间（这类贴片不进入 items 实景道具表）。
   同一视频反复出现的同类花字必须沿用已锁定的全片花字风格；若原片该单元无 (b) 类元素则不得凭空编造，onScreenText 留空字符串；无论有无花字都不得生成底部口播字幕。`;

/** 第一步：稀疏宫格 → 资产表 + 分镜大纲。 */
function overviewPrompt(meta: CopyVideoMeta, transcript: string) {
    return `你是一名电影导演、摄影指导和分镜设计师。这是分镜分析的第一步：只看全片稀疏宫格，建立资产表和分镜大纲，不要写逐镜细节。

视频元数据：
- 时长：${meta.duration.toFixed(1)} 秒
- 分辨率：${meta.width}x${meta.height}
- 格数：${meta.frameCount}（按时长均匀抽取，不是每一秒都有一格）
- 每格标了序号和时间点；格子在时间线上分布均匀，短镜头可能没有独立格子。

一、资产表
- roles：仅记录出场的人物角色或会说话/表演的拟人化主角（切勿把背包、蜂蜜罐、礼盒、普通商品、普通道具写进 roles）。description 写外观、年龄、体型、发型、服装、配饰、气质（用于生图，不要写声音）；voice 写性别、声音年龄、音色、音高、共鸣位置、语言/方言、基础语速（用于配音和视频声线锁定，不要写外观）。
- scenes：每个实际使用的场景一条，写地点、时间、天气、光线、环境布置、关键陈设。若多个子场景同属同一家展厅、住宅或门店的不同区域，每个出镜子区域分别建一条（如 @现代轻奢厨房、@高端书房会客区），并在 spaceContext 中统一锁定母空间风格。
- items：只记录实景物理道具、服饰单品或被展示售卖的商品主体（如背包、蜂蜜篮等），写外观、材质、颜色、状态。后期叠加在屏幕上的 UI 浮窗贴片（如手机短视频界面浮层）、花字、标签卡片不要写进 items。
- name 简短唯一；全片同一对象只允许一个 name。不得编写画面里没有出现的人物/场景/道具。

二、分镜大纲（outline）
- 按「一次生视频出片」的单元切分：每单元 5~15 秒，单元数量 ≈ 总时长 ÷ 10（上下浮动 2 个）。
- 每个单元写一句话剧情 summary，并列出本单元涉及的 roles / scenes / items（必须用资产表里的 name）。
- 单元首尾相接、覆盖全片，不留空档；边界优先落在场景切换、完整句末停顿或情绪转折处。

三、全片设定
- style：一句话写全片摄影画风、影调、光线、质感、剪辑节奏（例如「真人实景，4K 写实，暖中性室内光，浅景深，跟拍流畅」）。只写画面视觉质感，不要把文字或花字样式写进 style。
- spaceContext：若全片多个子场景同属一个统一空间体系（同一家展厅、同一套住宅或门店的不同区域），用一句话概括它们共享的装修风格、主材质色系（如木饰面、石材、柜体颜色）与灯光色温；若各场景彼此独立无共享空间则填 ""。
- textStyle：观察全片是否在画面中上部、居中、人物头顶或两侧留白区等主体区域出现非底部字幕的花字、大字标题、强调弹字、流程列表或信息条；若有，用一句话总结全片统一的字体、粗细、配色、描边/投影/底框、典型位置和常见出场动效（例如「白色超粗无衬线黑体大字，带深色柔和投影，常于人物头顶或左侧留白区居中弹出，伴随横向动态模糊残影冲击或逐项累加动效」）；严格忽略底部滚动的常规口播字幕条，若全片无此类屏幕花字则填 ""。
- title：一句话概括片子内容；ratio：画面比例，如 9:16。

${transcript ? `【音轨转写台词（带时间戳）】\n${transcript}\n核对台词与画面对应关系；同音字按上下文校正，但不得改写内容。` : "【本片没有可用的音轨转写】按画面唇形和字幕判断台词，看不清写「台词待核对」。"}

只输出 JSON（不要 markdown 代码块）：
{
  "title": "一句话概括",
  "ratio": "9:16",
  "style": "全片摄影风格一句话（不含文字或花字样式）",
  "spaceContext": "全片多子场景共享的统一空间母设定（没有则为空字符串）",
  "textStyle": "全片屏幕花字/标题文字统一视觉风格（不含底部口播字幕；没有则为空字符串）",
  "roles": [{ "name": "角色名", "description": "外观/服装/发型等", "voice": "性别、声音年龄、音色、音高、共鸣、语言/方言、基础语速" }],
  "scenes": [{ "name": "场景名", "description": "地点/时间/光线/陈设" }],
  "items": [{ "name": "物品名", "description": "外观/材质/颜色/状态" }],
  "outline": [{ "start": "0.0秒", "end": "10.0秒", "summary": "一句话剧情", "roles": ["角色名"], "scenes": ["场景名"], "items": ["物品名"] }]
}

只输出 JSON。`;
}

/** 第二步：逐时间窗细化，产出可直接出片的分镜单元。 */
function windowPrompt(meta: CopyVideoMeta, ctx: CopyWindowContext) {
    const lines = [
        `你是一名电影导演、摄影指导、表演指导和声音导演。这是分镜分析的第二步：把所有已锁定的资产交给模型，细化第 ${ctx.index}/${ctx.total} 个时间窗内的分镜单元。`,
        "",
        "视频元数据：",
        `- 时长：${meta.duration.toFixed(1)} 秒；分辨率：${meta.width}x${meta.height}`,
        `- 本窗范围：${ctx.startTime.toFixed(1)}~${ctx.endTime.toFixed(1)} 秒，宫格里的每一格都落在这个范围内，格子按时间顺序排列并标了时间点。`,
        ctx.cuts && ctx.cuts.length ? `- 本窗检测到 ${ctx.cuts.length} 处切点：${formatCuts(ctx.cuts)}（只作为节拍时间的参考，不要一个切点一个单元）。` : "",
        "",
        "【已锁定资产】以下名称必须原样沿用，不得重新设计，也不得给同一对象另起名字：",
        ctx.casting.roles.length ? `角色：${castingLine(ctx.casting.roles)}` : "角色：无",
        ctx.casting.scenes.length ? `场景：${castingLine(ctx.casting.scenes)}` : "场景：无",
        ctx.casting.items.length ? `物品：${castingLine(ctx.casting.items)}` : "物品：无",
        "本窗新出现、资产表里没有的物理角色/场景/道具可以补进输出数组，name 同样要简短唯一；后期屏幕 UI 浮窗贴片与花字不要放进 items。",
        "",
        ctx.spaceContext
            ? `【全片统一空间母设定】${ctx.spaceContext}\n本窗涉及的室内子场景必须保持该空间体系的装修、材质与灯光色温一致。`
            : "",
        ctx.textStyle
            ? `【已锁定屏幕花字风格（跨窗必须保持一致）】${ctx.textStyle}\n本窗出现屏幕主体花字/大字标题/序列弹字/标签时，必须沿用该字体、配色、描边/投影与动效风格，并在对应节拍细化精确文案、留白位置、出现编排（单组/替换/累积列表/UI贴片）与时机；同时严格忽略画面底部口播字幕。`
            : "【屏幕花字提醒】请逐格检查本窗画面上方、中上部、居中、人物周围留白区是否出现短时弹出的重点大字、花字、连续关键词、标签、招牌或 UI 浮窗贴片，若有请写入对应节拍的 videoPrompt 和 onScreenText；同时严格忽略画面底部常规口播字幕。",
        "",
        ctx.previousEndState
            ? `【上一单元结束状态${ctx.previousScene ? `（上一场景：${ctx.previousScene}）` : ""}】${ctx.previousEndState}\n请对照本窗第 1 格画面判断衔接方式：\n- 若本窗首格仍在同一场景且延续上一动作/行走/运镜：必须无缝承接站位、朝向、步伐、手势、运镜方向与语流，不重新起步、不重置姿态；\n- 若本窗首格已切换至新场景：明确写「硬切至 @新场景名」，交代人物在新场景的初始站位、朝向与前后景，同时保持人物外观与声音完全锁定。`
            : "",
        ctx.transcript ? `【本窗台词（带时间戳，必须逐字使用）】\n${ctx.transcript}\n台词按时间对齐到节拍；不得改写、增删、重复。时间戳与画面对不上时以画面为准并微调节拍，但台词文字保持原样。` : "【本窗没有可靠台词】按画面唇形/字幕判断，拿不准写「台词待核对」。",
        ctx.previousDialogue ? `【前面单元已经说过的台词（本窗不要重复）】${ctx.previousDialogue}
同一句台词全片只写一次；上一窗开始、本窗仍在延续的声音写「承接上一窗」，不要重抄整段。` : "",
        ctx.outline ? `【本窗剧情大纲】
${ctx.outline}` : "",
        "",
        directingRules,
        "",
        "【输出要求】",
        `- shots 只写完全落在本窗 ${ctx.startTime.toFixed(1)}~${ctx.endTime.toFixed(1)} 秒范围内的单元，按时间排序，首尾相接覆盖本窗。`,
        `- 单元时长 5~15 秒且不得超过本窗长度（${(ctx.endTime - ctx.startTime).toFixed(1)} 秒）；本窗不足 5 秒时只写一个覆盖整窗的单元。`,
        `- start / end / duration 一律用全片绝对时间（本窗起点是 ${ctx.startTime.toFixed(1)} 秒），不要每个窗都从 0.0 秒重新计时。`,
        "- 每个单元的 videoPrompt 第一行格式为「【起-止秒】无底部口播字幕」，之后每行一个节拍：「起-止秒：[延续/硬切至] @场景 中，<景别><角度><焦段感><机位高度><运动><构图与文字留白>拍摄。@角色 <位置朝向、与台词关键词同步的手势/微表情/呼吸>，说道（<语速/重读/情绪>）：\"台词\"。屏幕中<留白位置>以<字体/配色/投影/编排模式/动效>出现“精确文字”（<出现-消失时间>）。SFX/ENVIRONMENT：<伴随脚步/触碰/弹字音效，音量低于人声>。」",
        "- 每个节拍（无论有无台词）都补全脚步声、衣物摩擦、手指触碰物体、界面滑入、文字弹出、认知反转低频强调音等真实音效/环境声，标注声音类型并注明音效低于人声；镜头切至手部/局部特写但同一人继续说话时，仍标 DIALOGUE 延续原人物声线，不得改成旁白。",
        "- 严禁把画面底部随台词逐句滚动的常规口播字幕写进 videoPrompt 的画面文字或 onScreenText；若本单元无屏幕花字/招牌/价签/UI贴片等非底部视觉文字，onScreenText 必须填 \"\"。",
        "- 最后一个节拍写清收尾状态（含人物朝向/手势/运镜走势，可用「容错时间内保持…」），方便下一单元判断延续或硬切。",
        "- 结构化字段：shotSize / cameraAngle / cameraMove 写单元主镜头语言；description 写画面从第一帧到最后一帧的变化（含空间关系、构图留白与 UI 浮窗）；performance 写表演要点（含手势与关键词对应关系）；sound 写全节拍声音事件（带类型、语速情绪与 SFX）；dialogue 写本单元台词合并文本；onScreenText 写本单元需复刻的屏幕主体文字/花字/UI贴片（含精确文案、字体样式、留白位置、单组/替换/累积编排、动效与时间，不含底部字幕，没有则为空字符串）；roles / scenes / items 写本单元用到的资产名；imagePrompt 写该单元纯画面首帧生图提示词（150 字内，直接引用资产名，不写字幕和屏幕花字）。",
        "- title / ratio / style 不用重复输出，可以省略。",
        "",
        "只输出 JSON（不要 markdown 代码块）：",
        `{
  "shots": [{
    "start": "${ctx.startTime.toFixed(1)}秒",
    "end": "${Math.min(ctx.startTime + 8, ctx.endTime).toFixed(1)}秒",
    "duration": "${Math.min(8, ctx.endTime - ctx.startTime).toFixed(1)}秒",
    "videoPrompt": "【${ctx.startTime.toFixed(1)}-${Math.min(ctx.startTime + 8, ctx.endTime).toFixed(1)}秒】无底部口播字幕\n节拍1起-止秒：在 @场景名 中，…（写出景别/焦段/机位/留白、关键词同步动作、台词语气、屏幕花字/UI贴片及伴随 SFX）\n节拍2起-止秒：…",
    "shotSize": "特写/近景/中景/全景/远景",
    "cameraAngle": "平视/俯拍/仰拍/正面/侧面/过肩等，含机位高低",
    "cameraMove": "固定/推/拉/摇/移/跟/手持，含起止位置",
    "description": "画面：第一帧到最后一帧的变化（含留白区与前后景）",
    "performance": "表演：动机、眼神落点、微表情、呼吸、手势与台词关键词同步落点",
    "sound": "声音：DIALOGUE/ENVIRONMENT/SFX 等，含发声者、语气重读、伴随音效与起止",
    "dialogue": "本单元台词合并文本（没有则为空字符串）",
    "onScreenText": "屏幕花字/大字/序列弹字/列表/UI贴片/价签/招牌（含文案、样式、位置、动效与时间，不含底部字幕；没有则为空字符串）",
    "imagePrompt": "该单元纯画面首帧的图片描述词，150 字以内（不写字幕和屏幕花字）",
    "roles": ["角色名"],
    "scenes": ["场景名"],
    "items": ["物品名"]
  }],
  "roles": [{ "name": "本窗新角色", "description": "…", "voice": "…" }],
  "scenes": [], "items": []
}

只输出 JSON。`,
    ];
    return lines.filter(Boolean).join("\n");
}

/**
 * 场景检测抽帧：按固定步长采样小缩略图，和上一张比较像素差异，
 * 差异超过阈值就判定为「镜头切换」，保留该时刻的高清帧；再均匀补齐到 maxFrames。
 * 相比固定间隔抽帧，关键镜头不容易漏，重复帧也不会占满额度。
 */
export async function extractSceneFrames(file: File, maxFrames = 120, signal?: AbortSignal): Promise<{ frames: CopyFrame[]; meta: CopyVideoMeta }> {
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
        // 采样步长：短视频 0.2 秒（更容易踩到极短镜头），seek 总数仍控制在 600 以内。
        const step = duration <= 60 ? 0.2 : duration <= 300 ? 0.5 : 1;
        let previous: Uint8ClampedArray | null = null;
        let previousHist: Float32Array | null = null;
        const hist = new Float32Array(HIST_BINS * 3);
        const candidates: { time: number; pixelDiff: number; histDiff: number; dataUrl: string }[] = [];
        for (let t = 0; t < duration; t += step) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await seek(t);
            thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
            const pixels = thumbCtx.getImageData(0, 0, thumb.width, thumb.height).data;
            let pixelDiff = 0;
            if (previous) {
                for (let i = 0; i < pixels.length; i += 4) {
                    pixelDiff += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
                }
                pixelDiff /= (pixels.length / 4) * 3 * 255;
            }
            previous = new Uint8ClampedArray(pixels);
            // 直方图差分对摇镜、曝光变化不敏感，逐像素差分对同色系硬切更敏感，两个一起用。
            const currentHist = frameHistogram(pixels, hist);
            const histDiff = previousHist ? histogramDistance(currentHist, previousHist) : 0;
            previousHist = Float32Array.from(currentHist);
            fullCtx.drawImage(video, 0, 0, full.width, full.height);
            candidates.push({ time: t, pixelDiff, histDiff, dataUrl: full.toDataURL("image/jpeg", 0.78) });
        }

        // 先按差异找「镜头切换」作为场景边界，再在每个场景内挑帧。
        // 关键约束：每个场景至少留 1 帧（切点后的那一帧最能代表镜头起幅），
        // 切点检测：硬切看瞬时跳变，叠化/淡入淡出看「连续多帧小幅变化」的累积。
        // 选帧时按「每秒一帧 + 切点首帧」，这里只需要边界，不再按场景配额分帧。
        const sceneStarts = detectSceneStarts(candidates);
        const scenes = sceneStarts.map((item, index) => ({
            start: item.time,
            end: index + 1 < sceneStarts.length ? sceneStarts[index + 1].time : duration,
        }));
        const frameAt = (time: number) => {
            let closest = candidates[0];
            let closestDelta = Math.abs(candidates[0].time - time);
            for (const candidate of candidates) {
                const delta = Math.abs(candidate.time - time);
                if (delta < closestDelta) {
                    closest = candidate;
                    closestDelta = delta;
                }
            }
            return closest;
        };
        // 选帧策略：**每秒一帧**打底，再补每个切点的首帧。
        // 之前按场景分配（每场景 1~4 帧）在短剧上密度太低——12 秒的片子可能只给模型 3~6 格，
        // 硬切、手部动作、字幕变化全看不到。对标工具就是 1 fps 铺满整条时间线。
        const sceneIndexOf = (time: number) => {
            let index = 0;
            for (let i = 0; i < scenes.length; i += 1) {
                if (scenes[i].start <= time + 0.001) index = i;
                else break;
            }
            return index;
        };
        const picked: { time: number; scene: number }[] = [];
        const seenTime = new Set<number>();
        const addFrame = (time: number) => {
            const frame = frameAt(time);
            if (seenTime.has(frame.time)) return;
            seenTime.add(frame.time);
            picked.push({ time: frame.time, scene: sceneIndexOf(frame.time) });
        };
        // 1) 短视频（≤90 秒）按 0.5 秒一帧打底，长片按 1 秒一帧打底（零额外 seek 耗时），短于步长的间隔补最后一帧
        const baseStep = duration <= 90 ? 0.5 : 1;
        for (let t = 0; t < duration; t += baseStep) addFrame(t);
        addFrame(Math.max(0, duration - 0.05));
        // 2) 每个切点的首帧：1 秒网格可能正好跨过极短的硬切，补上才不会漏镜头
        sceneStarts.slice(1).forEach((item) => addFrame(item.time));

        const uniqueByTime = new Map<number, { time: number; scene: number }>();
        picked.forEach((item) => {
            if (!uniqueByTime.has(item.time)) uniqueByTime.set(item.time, item);
        });
        let pickedFrames = Array.from(uniqueByTime.values()).sort((a, b) => a.time - b.time);
        if (pickedFrames.length > maxFrames) {
            // 超预算：先保住每个切点的首帧（镜头起幅最要紧），剩下的按时间均匀抽，别让某段整段消失
            const cutTimes = new Set(sceneStarts.map((item) => item.time));
            const cuts = pickedFrames.filter((item) => cutTimes.has(item.time));
            const others = pickedFrames.filter((item) => !cutTimes.has(item.time));
            const room = Math.max(0, maxFrames - cuts.length);
            const thinned = room > 0 ? Array.from({ length: room }, (_, i) => others[Math.round((i * (others.length - 1)) / Math.max(1, room - 1))]) : [];
            pickedFrames = [...cuts, ...thinned].filter((item, index, list) => list.findIndex((other) => other.time === item.time) === index).sort((a, b) => a.time - b.time);
        }
        const finalPicked = pickedFrames
            .slice(0, maxFrames)
            .map((item) => ({ ...item, frame: candidates.find((candidate) => candidate.time === item.time) ?? frameAt(item.time) }));

        return {
            frames: finalPicked.map((item) => ({ time: item.time, dataUrl: item.frame.dataUrl, scene: item.scene })),
            meta: { duration, width, height, frameCount: finalPicked.length, sceneCount: sceneStarts.length, cuts: sceneStarts.map((item) => Number(item.time.toFixed(2))) },
        };
    } finally {
        URL.revokeObjectURL(src);
    }
}

/**
 * 把关键帧拼成宫格图（每格带序号和时间），一次请求就能让模型看到整条时间线。
 *
 * 格子尺寸不再是固定 200×112：按视频比例和帧数算「在像素预算内面积最大」的排布。
 * 之前竖屏视频也被塞进 16:9 的格子，两侧全是黑边，一半像素白白浪费；
 * 竖屏现在会排成 6~8 列，单格面积提升约 2.5 倍，模型才看得清服装、道具和画面文字。
 */
export async function buildFrameGrid(frames: CopyFrame[], aspect = 16 / 9): Promise<string> {
    const MAX_WIDTH = 1400;
    const MAX_HEIGHT = 1568; // 主流多模态模型的最优输入长边
    const LABEL_HEIGHT = 18;
    const safeAspect = Number.isFinite(aspect) && aspect >= 0.3 && aspect <= 3 ? aspect : 16 / 9;

    let best = { cols: 4, rows: Math.ceil(frames.length / 4), cellWidth: 0, cellHeight: 0 };
    for (let cols = 2; cols <= Math.min(12, Math.max(2, frames.length)); cols += 1) {
        const rows = Math.ceil(frames.length / cols);
        const heightBudget = MAX_HEIGHT - rows * LABEL_HEIGHT;
        if (heightBudget <= 0) continue;
        const byWidth = MAX_WIDTH / cols;
        const byHeight = (heightBudget / rows) * safeAspect;
        const cellWidth = Math.floor(Math.min(byWidth, byHeight));
        const cellHeight = Math.floor(cellWidth / safeAspect);
        if (cellWidth * cellHeight > best.cellWidth * best.cellHeight) best = { cols, rows, cellWidth, cellHeight };
    }
    const { cols, rows, cellWidth, cellHeight } = best;

    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * cols;
    canvas.height = (cellHeight + LABEL_HEIGHT) * rows;
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
        const y = row * (cellHeight + LABEL_HEIGHT);
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(x, y + LABEL_HEIGHT, cellWidth, cellHeight);
        if (images[index]?.complete) ctx.drawImage(images[index], x, y + LABEL_HEIGHT, cellWidth, cellHeight);
        ctx.fillStyle = "rgba(17,24,39,0.9)";
        ctx.fillRect(x, y, cellWidth, LABEL_HEIGHT);
        ctx.fillStyle = "#f9fafb";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`#${index + 1}  ${frame.time.toFixed(1)}s`, x + 6, y + LABEL_HEIGHT / 2);
    });
    return canvas.toDataURL("image/jpeg", 0.85);
}

/** 调用多模态模型分析宫格图。sessionToken 必须是后台登录态 token（不是中转 key）。 */
/** 提交一次分析任务并轮询到完成，返回模型输出原文（提交/查询都走登录态）。 */
async function runAnalyzeJob(sessionToken: string, model: string, prompt: string, image: string, signal?: AbortSignal): Promise<string> {
    if (!sessionToken.trim()) throw new Error("请先登录后再分析");
    // 走异步任务：长请求会被链路中间代理 120s 掐断，改成「提交 + 轮询」。
    // 用同源相对路径：`/api/user/**` 挂的是 UserAuth，只认后台登录态 token；
    // 渠道里那个中转 key（sk-...）会被判成「access token 无效」。
    // key 和 baseUrl 都不再上传 —— 服务端按登录用户自己取令牌、地址固定本机回环，
    // 既不让凭证出现在请求体里，也避免 baseUrl 被拿去打内网（SSRF）。
    const endpoint = "/api/user/copy/analyze";
    const headers = { Authorization: `Bearer ${sessionToken.trim()}` };
    // 把后端的中文 message（如「access token 无效」）透出来，别只显示 HTTP 401。
    const submit = await axios.post(endpoint, { model, prompt, image }, { headers, signal, timeout: 30000 }).catch((error: unknown) => {
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
        if (data.status === "done") return String(data.content || "");
        if (data.status === "failed") throw new Error(data.error || "分析失败");
    }
}

/** 第一步：全片资产表 + 分镜大纲。 */
export async function analyzeOverview(
    gridDataUrl: string,
    meta: CopyVideoMeta,
    model: string,
    sessionToken: string,
    transcript = "",
    signal?: AbortSignal,
): Promise<CopyOverview> {
    const content = await runAnalyzeJob(sessionToken, model, overviewPrompt(meta, transcript), gridDataUrl, signal);
    return normalizeOverview(extractJson(content));
}

/** 第二步：按时间窗逐个细化分镜单元。 */
export async function analyzeShotsWindow(
    gridDataUrl: string,
    meta: CopyVideoMeta,
    model: string,
    sessionToken: string,
    ctx: CopyWindowContext,
    signal?: AbortSignal,
): Promise<CopyAnalysis> {
    const content = await runAnalyzeJob(sessionToken, model, windowPrompt(meta, ctx), gridDataUrl, signal);
    const clamped = clampWindowShots(normalizeAnalysis(extractJson(content)), ctx.startTime, ctx.endTime);
    const mergedAssets = {
        roles: [...ctx.casting.roles, ...clamped.roles.filter((item) => !ctx.casting.roles.some((base) => base.name === item.name))],
        scenes: [...ctx.casting.scenes, ...clamped.scenes.filter((item) => !ctx.casting.scenes.some((base) => base.name === item.name))],
        items: [...ctx.casting.items, ...clamped.items.filter((item) => !ctx.casting.items.some((base) => base.name === item.name))],
    };
    return { ...clamped, shots: syncShotAssetsFromPrompt(clamped.shots, mergedAssets) };
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

export type TranscriptSegment = { start: number; end: number; text: string };

/** "1:02:03,400" / "02:03.4" / "12.5" → 秒。 */
function timecodeToSeconds(value: string) {
    const text = String(value || "").trim().replace(",", ".");
    const parts = text.split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return NaN;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/**
 * 解析带时间戳的转写：支持
 *   [00:00:01,240 --> 00:00:03,500] 台词
 *   [00:01 - 00:03] 台词
 *   [00:01,240 - 00:03,500] 台词
 * 没有时间戳的整段文本返回空数组（调用方降级为「不带时间轴的台词」）。
 */
const TIMECODE = "\\d{1,2}:\\d{1,2}(?::\\d{1,2})?(?:[.,]\\d{1,3})?";

/** 按中文/英文句末标点和换行拆句。 */
function splitSentences(text: string) {
    return String(text || "")
        .split(/(?<=[。！？!?；;])|\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * 腾讯经常把一整段话识别成一句（`[0:0.000,0:30.080] 全文…`）。
 * 这种整句没法按时间窗分配，按标点拆句后按字数比例分摊时间，至少每个窗口只拿到属于自己那段。
 * 时间比例是估算，提示词里已要求「时间戳与画面对不上时以画面为准」。
 */
function splitBySentence(segment: TranscriptSegment): TranscriptSegment[] {
    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) return [segment];
    const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    const span = Math.max(0.1, segment.end - segment.start);
    let cursor = segment.start;
    return sentences.map((sentence) => {
        const next = { start: cursor, end: cursor + (span * sentence.length) / total, text: sentence };
        cursor = next.end;
        return next;
    });
}

export function parseTranscript(raw: string): TranscriptSegment[] {
    const text = String(raw || "");
    if (!text.trim()) return [];
    const segments: TranscriptSegment[] = [];
    const range = new RegExp(`\\[\\s*(${TIMECODE})\\s*(?:-->|->|~|-|,)\\s*(${TIMECODE})\\s*\\]\\s*([^\\[\\n]+)`, "g");
    for (const match of text.matchAll(range)) {
        const start = timecodeToSeconds(match[1]);
        const end = timecodeToSeconds(match[2]);
        const line = match[3].trim();
        if (!line || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        segments.push({ start, end, text: line });
    }
    if (segments.length) return segments.sort((a, b) => a.start - b.start).flatMap(splitBySentence);
    // 兜底：只有单个时间点（[0:00:12,300] 台词）的格式，用下一行的时间点当结束，最后一行按 3 秒补齐。
    const points: { time: number; text: string }[] = [];
    const pointPattern = new RegExp(`\\[\\s*(${TIMECODE})\\s*\\]\\s*([^\\[\\n]+)`, "g");
    for (const match of text.matchAll(pointPattern)) {
        const time = timecodeToSeconds(match[1]);
        const line = match[2].trim();
        if (line && Number.isFinite(time)) points.push({ time, text: line });
    }
    return points
        .sort((a, b) => a.time - b.time)
        .map((point, index) => ({ start: point.time, end: index + 1 < points.length ? points[index + 1].time : point.time + 3, text: point.text }))
        .flatMap(splitBySentence);
}

/** 完全没有时间戳时：把整段按句子均分到全片时长。 */
export function spreadTranscript(raw: string, duration: number): TranscriptSegment[] {
    const sentences = splitSentences(raw);
    if (!sentences.length || !Number.isFinite(duration) || duration <= 0) return [];
    const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    let cursor = 0;
    return sentences.map((sentence) => {
        const span = (duration * sentence.length) / total;
        const segment = { start: cursor, end: cursor + span, text: sentence };
        cursor += span;
        return segment;
    });
}

/** 整片台词（给第一步做全局理解用）。没有时间戳时原样返回。 */
export function formatTranscript(raw: string, segments: TranscriptSegment[]) {
    if (!segments.length) return String(raw || "").trim();
    return segments.map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}秒：${segment.text}`).join("\n");
}

/** 只取落在本时间窗内的台词：按句首时间严格分区，相邻窗口不重不漏。 */
export function transcriptForWindow(segments: TranscriptSegment[], start: number, end: number, isLast = false) {
    const min = start <= 0.01 ? -Infinity : start;
    const max = isLast ? Infinity : end;
    return segments
        .filter((segment) => segment.start >= min && segment.start < max)
        .map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}秒：${segment.text}`)
        .join("\n");
}

/** 角色/场景/物品 → 生成一张参考图（返回 dataUrl 或图片 URL）。提示词由调用方按素材类型拼好。 */
export async function generateItemImage(config: AiConfig, prompt: string, signal?: AbortSignal): Promise<string> {
    const images = await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜 → 生成该镜首帧图（返回 dataUrl）；有参考图时走图生图，人物和场景更贴近原片。 */
export async function generateShotImage(config: AiConfig, shot: CopyShot, references: ReferenceImage[] = [], style = "", signal?: AbortSignal): Promise<string> {
    const prompt = shotImagePrompt(shot, style);
    const images = references.length
        ? await requestEdit({ ...config, count: "1" }, prompt, references, { signal })
        : await requestGeneration({ ...config, count: "1" }, prompt, { signal });
    if (!images.length) throw new Error("生图没有返回结果");
    return images[0].dataUrl;
}

/** 分镜图提示词：优先用模型写好的 imagePrompt，没有就按分镜字段拼一段。 */
export const SIX_GRID_RULE = [
    "输出一张六宫格分镜图：把这一镜头按时间顺序拆成 6 个关键瞬间，排成 3 列 × 2 行，从左到右、从上到下阅读。",
    "六格必须是同一个镜头、同一个人物造型、同一场景与光线，只是动作与机位有连续变化；格与格之间留均匀的细白或细黑分隔。",
    "六格画面里都不要出现任何文字：不要标题、字幕、标签、水印、Logo 和乱码。",
].join("\n");

export function shotImagePrompt(shot: CopyShot, style = ""): string {
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const body = shot.imagePrompt || [camera, shot.description, shot.performance].filter(Boolean).join("。");
    return [style ? `风格：${style}` : "", body, SIX_GRID_RULE].filter(Boolean).join("\n");
}

/**
 * 批量「生成图片描述词」：把分镜已有的画面/镜头/角色字段拼成一条可直接生图的提示词，
 * 用于模型漏写 imagePrompt 时补全（和参考产品一样，可以再手动改）。
 */
export function composeShotImagePrompt(shot: CopyShot, analysis: CopyAnalysis): string {
    const describe = (names: string[], list: CopyItem[]) =>
        names
            .map((name) => {
                const item = list.find((entry) => entry.name === name);
                return item && item.description ? `${item.name}（${item.description}）` : name;
            })
            .filter(Boolean)
            .join("；");
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const space = cleanOnScreenText(analysis.spaceContext || "");
    const lines = [
        analysis.style ? `风格：${analysis.style}` : "",
        space && shot.scenes.length ? `空间统一：${space}` : "",
        camera ? `镜头：${camera}` : "",
        shot.description ? `画面：${shot.description}` : "",
        shot.roles.length ? `角色：${describe(shot.roles, analysis.roles)}` : "",
        shot.scenes.length ? `场景：${describe(shot.scenes, analysis.scenes)}` : "",
        shot.items.length ? `物品：${describe(shot.items, analysis.items)}` : "",
    ];
    return lines.filter(Boolean).join("\n");
}

/** 每个分镜配一张「原视频分镜图」：按分镜起始时间取最近的抽帧。 */
export function matchFramesToShots(analysis: CopyAnalysis, frames: CopyFrame[]): Record<string, string> {
    const map: Record<string, string> = {};
    if (!frames.length) return map;
    for (const shot of analysis.shots) {
        const start = shotStartSeconds(shot.start);
        let best = frames[0];
        let delta = Math.abs(best.time - start);
        for (const frame of frames) {
            const next = Math.abs(frame.time - start);
            if (next < delta) {
                best = frame;
                delta = next;
            }
        }
        map[shot.id] = best.dataUrl;
    }
    return map;
}

/** 分镜 → 生成一段视频（首帧参考图可选），返回已入库的素材（url + storageKey）。 */
export async function generateShotVideo(
    config: AiConfig,
    shot: CopyShot,
    references: ReferenceImage[] = [],
    style = "",
    signal?: AbortSignal,
    context?: ShotPromptContext,
): Promise<UploadedFile> {
    const prompt = shotPrompt(shot, style, context);
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

const SPOKEN_CUE_RE = /(说道|口播|台词|DIALOGUE|：“|:")/;

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortedAssetNames(assetNames: string[]): string[] {
    return Array.from(new Set(assetNames.map((name) => String(name || "").trim()).filter(Boolean))).sort((a, b) => b.length - a.length);
}

/** 按最长资产名优先拆分正文中的 `@资产名`，避免前缀包含关系截断（如 `@老头卧室` 被 `@老头` 截断）。 */
export function splitPromptAssetTokens(text: string, assetNames: string[]): PromptAssetToken[] {
    const source = String(text ?? "");
    if (!source) return [];
    const names = sortedAssetNames(assetNames);
    if (!names.length) return [{ type: "text", value: source }];
    const pattern = new RegExp(`@(?:${names.map(escapeRegExp).join("|")})`, "g");
    const tokens: PromptAssetToken[] = [];
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > cursor) tokens.push({ type: "text", value: source.slice(cursor, index) });
        const raw = match[0];
        tokens.push({ type: "mention", name: raw.slice(1), raw });
        cursor = index + raw.length;
    }
    if (cursor < source.length) tokens.push({ type: "text", value: source.slice(cursor) });
    return tokens;
}

const ASSET_SECTIONS: ReadonlyArray<{ section: CopyAssetSection; kind: CopyAssetKind }> = [
    { section: "roles", kind: "role" },
    { section: "scenes", kind: "scene" },
    { section: "items", kind: "item" },
];

/** 合并 `shot.roles/scenes/items` 与正文中的 `@资产名`，按角色 → 场景 → 物品排序并按 id 去重。 */
export function resolveShotBoundAssets(shot: CopyShot, assets: Pick<CopyAnalysis, "roles" | "scenes" | "items">): CopyResolvedAsset[] {
    const allNames = ASSET_SECTIONS.flatMap(({ section }) => (assets[section] ?? []).map((item) => item.name));
    const mentioned = new Set(
        splitPromptAssetTokens(shot.videoPrompt || "", allNames)
            .filter((token): token is Extract<PromptAssetToken, { type: "mention" }> => token.type === "mention")
            .map((token) => token.name),
    );
    const resolved: CopyResolvedAsset[] = [];
    const seenIds = new Set<string>();
    for (const { section, kind } of ASSET_SECTIONS) {
        const list = assets[section] ?? [];
        const shotNames = new Set((shot[section] ?? []).map((name) => String(name || "").trim()).filter(Boolean));
        const pushItem = (item: CopyItem) => {
            if (seenIds.has(item.id)) return;
            seenIds.add(item.id);
            resolved.push({ id: item.id, name: item.name, description: item.description, kind, section });
        };
        for (const name of shotNames) {
            const match = list.find((item) => item.name === name);
            if (match) pushItem(match);
        }
        for (const item of list) {
            if (mentioned.has(item.name)) pushItem(item);
        }
    }
    return resolved;
}

/** 根据正文里出现的 `@资产名` 补齐每条分镜的 `roles / scenes / items` 字段。 */
export function syncShotAssetsFromPrompt(shots: CopyShot[], assets: Pick<CopyAnalysis, "roles" | "scenes" | "items">): CopyShot[] {
    const allNames = ASSET_SECTIONS.flatMap(({ section }) => (assets[section] ?? []).map((item) => item.name));
    if (!allNames.length) return shots;
    const namesBySection = {
        roles: new Set((assets.roles ?? []).map((item) => item.name)),
        scenes: new Set((assets.scenes ?? []).map((item) => item.name)),
        items: new Set((assets.items ?? []).map((item) => item.name)),
    };
    return shots.map((shot) => {
        const mentioned = splitPromptAssetTokens(shot.videoPrompt || "", allNames)
            .filter((token): token is Extract<PromptAssetToken, { type: "mention" }> => token.type === "mention")
            .map((token) => token.name);
        if (!mentioned.length) return shot;
        const merge = (existing: string[], allowed: Set<string>) => {
            const next = Array.from(new Set(existing.map((item) => item.trim()).filter(Boolean)));
            for (const name of mentioned) {
                if (allowed.has(name) && !next.includes(name)) next.push(name);
            }
            return next;
        };
        const roles = merge(shot.roles ?? [], namesBySection.roles);
        const scenes = merge(shot.scenes ?? [], namesBySection.scenes);
        const items = merge(shot.items ?? [], namesBySection.items);
        if (roles.length === (shot.roles ?? []).length && scenes.length === (shot.scenes ?? []).length && items.length === (shot.items ?? []).length) {
            return shot;
        }
        return { ...shot, roles, scenes, items };
    });
}

function replaceMentionInText(text: string, targetName: string, replacement: string, allAssetNames: string[]): string {
    if (!text) return text;
    const tokens = splitPromptAssetTokens(text, [...allAssetNames, targetName]);
    return tokens.map((token) => (token.type === "mention" && token.name === targetName ? replacement : token.type === "mention" ? token.raw : token.value)).join("");
}

/** 资产改名时同步替换分镜引用数组与提示词里的 `@旧名`。 */
export function renameAssetInShots(
    shots: CopyShot[],
    section: CopyAssetSection,
    oldName: string,
    newName: string,
    allAssetNames: string[],
): CopyShot[] {
    const from = oldName.trim();
    const to = newName.trim();
    if (!from || !to || from === to) return shots;
    return shots.map((shot) => {
        const updatedList = Array.from(new Set((shot[section] ?? []).map((item) => (item === from ? to : item)).filter(Boolean)));
        return {
            ...shot,
            [section]: updatedList,
            videoPrompt: replaceMentionInText(shot.videoPrompt || "", from, `@${to}`, allAssetNames),
            imagePrompt: replaceMentionInText(shot.imagePrompt || "", from, `@${to}`, allAssetNames),
        };
    });
}

/** 解绑分镜中的某个资产：从数组移除，并去掉正文里该资产的 `@` 前缀。 */
export function unbindAssetInShot(shot: CopyShot, section: CopyAssetSection, name: string, allAssetNames: string[]): CopyShot {
    const target = name.trim();
    if (!target) return shot;
    return {
        ...shot,
        [section]: (shot[section] ?? []).filter((item) => item !== target),
        videoPrompt: replaceMentionInText(shot.videoPrompt || "", target, target, allAssetNames),
    };
}

function bindingKindLabel(kind: ShotReferenceBinding["kind"]): string {
    if (kind === "role") return "角色";
    if (kind === "scene") return "场景";
    if (kind === "item") return "物品";
    return "分镜参考图";
}

function buildReferenceBindingHeader(bindings: ShotReferenceBinding[]): string {
    if (!bindings.length) return "";
    const parts = bindings.map((binding) =>
        binding.kind === "storyboard" ? `图片${binding.index}=${binding.name}` : `图片${binding.index}=@${binding.name}（${bindingKindLabel(binding.kind)}）`,
    );
    return `参考图对应：${parts.join("；")}。请严格按对应参考图保持人物五官服装、场景环境和物品一致。`;
}

function annotateMentionsWithBindings(text: string, bindings: ShotReferenceBinding[]): string {
    const assetBindings = bindings.filter((binding) => binding.kind !== "storyboard");
    if (!assetBindings.length || !text) return text;
    const byName = new Map(assetBindings.map((binding) => [binding.name, binding]));
    const names = Array.from(byName.keys());
    return text
        .split(/\r?\n/)
        .map((line) => {
            if (line.startsWith("参考图对应：") || line.startsWith("声线锁定：")) return line;
            let rebuilt = "";
            for (const token of splitPromptAssetTokens(line, names)) {
                if (token.type === "text") {
                    rebuilt += token.value;
                    continue;
                }
                const binding = byName.get(token.name);
                if (binding && !/(?:图片|图)\d+(?:=|（)$/.test(rebuilt)) {
                    rebuilt += `图片${binding.index}（@${binding.name}）`;
                } else {
                    rebuilt += token.raw;
                }
            }
            return rebuilt;
        })
        .join("\n");
}

/** 把提示词中的 `@资产名` 绑定到实际上传的 `图片1 / 图片2 ...` 序号并加上参考图对应说明。 */
export function bindShotReferencesInPrompt(prompt: string, bindings: ShotReferenceBinding[]): string {
    const source = String(prompt ?? "");
    if (!bindings.length) return source;
    const annotated = annotateMentionsWithBindings(source, bindings);
    if (annotated.includes("参考图对应：")) return annotated;
    const header = buildReferenceBindingHeader(bindings);
    return [header, annotated].filter(Boolean).join("\n");
}

function formatShotVoiceLock(shot: CopyShot, roles?: CopyItem[]): string {
    const voiced = (roles ?? []).filter((role) => cleanOnScreenText(role.voice || ""));
    if (!voiced.length) return "";
    const promptText = String(shot.videoPrompt || "");
    let matched = voiced.filter((role) => shot.roles.includes(role.name) || promptText.includes(`@${role.name}`));
    if (!matched.length && voiced.length === 1 && (String(shot.dialogue || "").trim() || SPOKEN_CUE_RE.test(promptText))) {
        matched = [voiced[0]];
    }
    if (!matched.length) return "";
    return `声线锁定：${matched.map((role) => `@${role.name}（${cleanOnScreenText(role.voice || "")}）`).join("；")}；全片保持同一音色、方言与基础语速，切特写延续现场口播不改旁白。`;
}

/**
 * 分镜 → 视频提示词。按「参考图对应 → 风格 → 空间统一 → 声线锁定 → 逐节拍时间线」拼，
 * 景别/机位/运动单独成句，避免和画面描述混在一起被模型忽略。
 */
export function shotPrompt(shot: CopyShot, style = "", context?: ShotPromptContext): string {
    // 分析阶段已经写好「整段范围 + 逐节拍时间线」，直接用它出片；老数据没有时才按字段拼。
    const camera = [shot.shotSize, shot.cameraAngle, shot.cameraMove].filter(Boolean).join("，");
    const onScreenText = cleanOnScreenText(shot.onScreenText);
    const fallbackParts = [
        camera,
        shot.description,
        shot.performance,
        shot.dialogue ? `台词：${shot.dialogue}` : "",
        onScreenText ? `屏幕文字复刻：${onScreenText}` : "",
    ].filter(Boolean);
    if (fallbackParts.length) fallbackParts.push("画面底部不出现口播字幕。");
    const rawBody = String(shot.videoPrompt || "").trim() || fallbackParts.join("\n");
    const bindings = context?.referenceBindings ?? [];
    const body = bindings.length ? annotateMentionsWithBindings(rawBody, bindings) : rawBody;
    const space = cleanOnScreenText(context?.spaceContext || "");
    const voiceLock = formatShotVoiceLock(shot, context?.roles);
    const refHeader = bindings.length && !body.includes("参考图对应：") ? buildReferenceBindingHeader(bindings) : "";
    const prompt = [
        refHeader,
        style ? `风格：${style}` : "",
        space && !body.includes("空间统一：") ? `空间统一：${space}` : "",
        voiceLock && !body.includes("声线锁定：") ? voiceLock : "",
        body,
    ]
        .filter(Boolean)
        .join("\n");
    return prompt || shot.description || "复刻原片镜头的画面与运镜";
}

function extractJson(text: string): Record<string, unknown> {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("模型没有返回可解析的 JSON");
    const body = candidate.slice(start);
    const parsed = parseJsonLoose(body);
    if (parsed) return parsed;
    // 输出被 max_tokens 截断时会给到半截 JSON：把最后一个完整元素之前的括号补齐，
    // 保住已经写好的角色/分镜，而不是让用户白等两分钟。
    const repaired = parseJsonLoose(closeUnclosedJson(body));
    if (repaired) return repaired;
    throw new Error("模型返回的 JSON 不完整（多半是分镜太多被截断），请缩短视频或减少分镜后重试");
}

/** 截掉模型在 JSON 后面补的说明文字后再解析；失败返回 null。 */
function parseJsonLoose(value: string): Record<string, unknown> | null {
    const end = value.lastIndexOf("}");
    const attempts = end > 0 && end < value.length - 1 ? [value, value.slice(0, end + 1)] : [value];
    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
            // 试下一种截法
        }
    }
    return null;
}

/**
 * 补全被截断的 JSON：找到最后一个**结构上**完整的闭合点，把没闭合的括号补上。
 * 扫的时候跳过字符串内部——模型写的描述里经常出现 `}`、`]` 这类字符，
 * 直接按字符串位置截会把它们当成结构。
 */
function closeUnclosedJson(value: string): string {
    const stack: string[] = [];
    const boundaries: number[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{" || char === "[") {
            stack.push(char === "{" ? "}" : "]");
        } else if (char === "}" || char === "]") {
            stack.pop();
            boundaries.push(index + 1);
        }
    }
    // 从后往前试：最后一个闭合点通常就是「截断前最后一个完整元素」。
    for (let cursor = boundaries.length - 1; cursor >= 0 && cursor >= boundaries.length - 4; cursor -= 1) {
        const head = value.slice(0, boundaries[cursor]);
        const closers: string[] = [];
        let nested = false;
        let quote = false;
        let slash = false;
        for (let index = 0; index < head.length; index += 1) {
            const char = head[index];
            if (quote) {
                if (slash) slash = false;
                else if (char === "\\") slash = true;
                else if (char === '"') quote = false;
                continue;
            }
            if (char === '"') quote = true;
            else if (char === "{") closers.push("}");
            else if (char === "[") closers.push("]");
            else if (char === "}" || char === "]") closers.pop();
            nested = closers.length > 0;
        }
        if (!nested) continue;
        const candidate = head + closers.reverse().join("\n");
        if (parseJsonLoose(candidate)) return candidate;
    }
    return "";
}

function normalizeItems(value: unknown, section: "roles" | "scenes" | "items", stamp: number): CopyItem[] {
    return (Array.isArray(value) ? value : [])
        .map((item, index) => {
            const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
            const name = String(record.name ?? "").trim();
            if (!name) return null;
            return {
                id: `${section}-${stamp}-${index}`,
                name,
                description: String(record.description ?? "").trim(),
                ...(section === "roles" ? { voice: String(record.voice ?? "").trim() } : {}),
            };
        })
        .filter((item): item is CopyItem => Boolean(item));
}

const EMPTY_TEXT_PLACEHOLDER = /^(?:无|没有|暂无|无画面文字|无屏幕文字|无花字|无文字|none|null|n\/a|-|—)+[。.]?$/i;
const NO_BOTTOM_SUBTITLE_RE = /(无底部|不要底部|不出现底部|不含底部|底部不出现|无口播字幕|不加字幕|无字幕)/;
const VISUAL_TEXT_KEYWORD_RE =
    /(花字|大字|小字|粗体|黑体|宋体|楷体|圆体|手写体|艺术字|立体字|字体|字样|标题|弹字|浮字|画面文字|屏幕文字|文字复刻|文字动效|标语|价签|身份条|招牌|包装字|贴片|标签卡|信息条|关键词|残影|描边|投影|外发光)/;

/** 清理模型返回的空占位词（如「无」「暂无」「none」），统一为空字符串。 */
export function cleanOnScreenText(value: string): string {
    const trimmed = String(value || "").trim();
    if (!trimmed || EMPTY_TEXT_PLACEHOLDER.test(trimmed)) return "";
    return trimmed;
}

/**
 * 分镜视频提示词文字规则兜底：
 * 1) 缺少禁用底部口播字幕声明时补在首行；
 * 2) 若有屏幕花字/主体文字（onScreenText 非空）但 videoPrompt 中漏写了视觉文字描述，
 *    将 `屏幕文字复刻：...` 插入首行之后（不追加在最后一行，以免影响 previousEndState）。
 */
export function ensureVideoPromptTextRules(videoPrompt: string, onScreenText: string): string {
    const trimmed = String(videoPrompt || "").trim();
    if (!trimmed) return "";
    const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length) return "";

    if (!NO_BOTTOM_SUBTITLE_RE.test(trimmed)) {
        if (lines[0].startsWith("【")) {
            lines[0] = `${lines[0]} 无底部口播字幕`;
        } else {
            lines.unshift("画面底部不出现口播字幕");
        }
    }

    const cleanedText = cleanOnScreenText(onScreenText);
    if (cleanedText && !VISUAL_TEXT_KEYWORD_RE.test(trimmed)) {
        const insertAt = lines[0].startsWith("【") ? 1 : 0;
        lines.splice(insertAt, 0, `屏幕文字复刻：${cleanedText}`);
    }

    return lines.join("\n");
}

export function normalizeOverview(raw: Record<string, unknown>): CopyOverview {
    const stamp = Date.now();
    const outline: CopyOutlineUnit[] = (Array.isArray(raw.outline) ? raw.outline : [])
        .map((unit) => {
            const record = (unit && typeof unit === "object" ? unit : {}) as Record<string, unknown>;
            const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
            return {
                start: String(record.start ?? "").trim(),
                end: String(record.end ?? "").trim(),
                summary: String(record.summary ?? "").trim(),
                roles: asList(record.roles),
                scenes: asList(record.scenes),
                items: asList(record.items),
            };
        })
        .filter((unit) => unit.start && unit.end);
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        style: String(raw.style ?? "").trim(),
        spaceContext: cleanOnScreenText(String(raw.spaceContext ?? "")),
        textStyle: cleanOnScreenText(String(raw.textStyle ?? "")),
        roles: normalizeItems(raw.roles, "roles", stamp),
        scenes: normalizeItems(raw.scenes, "scenes", stamp),
        items: normalizeItems(raw.items, "items", stamp),
        outline,
    };
}

/** 把第二步产出的实体并回第一步的资产表：同名的以资产表为准，新出现的追加。 */
export function mergeCasting(overview: CopyOverview, extra: { roles: CopyItem[]; scenes: CopyItem[]; items: CopyItem[] }) {
    const merge = (base: CopyItem[], add: CopyItem[]) => {
        const names = new Set(base.map((item) => item.name));
        return [...base, ...add.filter((item) => !names.has(item.name))];
    };
    return {
        roles: merge(overview.roles, extra.roles),
        scenes: merge(overview.scenes, extra.scenes),
        items: merge(overview.items, extra.items),
    };
}

/**
 * 窗口产出的时间要归一：模型可能写成窗内相对时间（从 0 开始），也可能越过窗口边界。
 * 这里统一映射成全片绝对时间并夹在本窗内，单元时长封顶 15 秒；完全落在窗外的丢弃。
 * 不做这一步，几个窗口会各自从 0 秒开始，合并时按起始时间去重，后面的单元就全没了。
 */
export function clampWindowShots(analysis: CopyAnalysis, start: number, end: number): CopyAnalysis {
    const shots = analysis.shots
        .map((shot) => {
            let s = shotStartSeconds(shot.start);
            let e = shotStartSeconds(shot.end);
            if (!Number.isFinite(s)) s = start;
            if (!Number.isFinite(e) || e <= s) e = s + Math.min(8, Math.max(1, end - s));
            // 窗内相对时间 → 绝对时间（只对非首个窗口做，避免把 0.x 秒的合法起点改坏）
            if (start > 0.05 && s < start - 0.5) {
                s += start;
                e += start;
            }
            s = Math.max(start, Math.min(s, Math.max(start, end - 0.1)));
            e = Math.min(end, Math.max(s + 0.1, e));
            if (e - s > 15) e = s + 15;
            return { ...shot, start: `${s.toFixed(1)}秒`, end: `${e.toFixed(1)}秒`, duration: `${(e - s).toFixed(1)}秒` };
        })
        .filter((shot) => Number(shot.end.replace(/[^0-9.]/g, "")) > Number(shot.start.replace(/[^0-9.]/g, "")));
    return { ...analysis, shots };
}

function normalizeAnalysis(raw: Record<string, unknown>): CopyAnalysis {
    const stamp = Date.now();
    // id 必须按分区加前缀：roles/scenes/items 各自从 0 开始编号，
    // 之前三个分区都用 `item-<stamp>-<index>`，导致角色 0 / 场景 0 / 物品 0 是同一个 id，
    // 生成一张图会同时显示在三个分区里（itemImages 是按 id 存的），后续生成还会互相覆盖。
    const toItems = (value: unknown, section: "roles" | "scenes" | "items"): CopyItem[] => normalizeItems(value, section, stamp);
    const toShots = (value: unknown): CopyShot[] =>
        (Array.isArray(value) ? value : [])
            .map((item, index) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
                const text = (key: string) => String(record[key] ?? "").trim();
                const onScreenText = cleanOnScreenText(text("onScreenText"));
                return {
                    id: `shot-${stamp}-${index}`,
                    start: text("start"),
                    end: text("end"),
                    duration: text("duration"),
                    videoPrompt: ensureVideoPromptTextRules(text("videoPrompt"), onScreenText),
                    shotSize: text("shotSize"),
                    cameraAngle: text("cameraAngle"),
                    cameraMove: text("cameraMove"),
                    description: text("description"),
                    performance: text("performance"),
                    sound: text("sound"),
                    dialogue: text("dialogue"),
                    onScreenText,
                    imagePrompt: text("imagePrompt"),
                    roles: asList(record.roles),
                    scenes: asList(record.scenes),
                    items: asList(record.items),
                };
            })
            .filter((shot) => shot.description || shot.roles.length);
    const spaceContext = cleanOnScreenText(String(raw.spaceContext ?? ""));
    const roles = toItems(raw.roles, "roles");
    const scenes = toItems(raw.scenes, "scenes");
    const items = toItems(raw.items, "items");
    return {
        title: String(raw.title ?? "").trim() || "爆款转绘",
        ratio: String(raw.ratio ?? "").trim(),
        style: String(raw.style ?? "").trim(),
        ...(spaceContext ? { spaceContext } : {}),
        roles,
        scenes,
        items,
        shots: syncShotAssetsFromPrompt(toShots(raw.shots), { roles, scenes, items }),
    };
}

function countSentenceSplits(boundaries: number[], segments: TranscriptSegment[]): number {
    let count = 0;
    for (const boundary of boundaries) {
        if (segments.some((segment) => segment.start + 0.35 < boundary && boundary < segment.end - 0.35)) count += 1;
    }
    return count;
}

function splitLongInterval(
    start: number,
    end: number,
    minWindow: number,
    maxWindow: number,
    cuts: number[],
    segments: TranscriptSegment[],
): { start: number; end: number }[] {
    const span = end - start;
    if (span <= maxWindow) return [{ start, end }];
    const minParts = Math.ceil(span / maxWindow);
    const maxParts = Math.max(minParts, Math.floor(span / minWindow));

    const buildParts = (parts: number) => {
        const result: { start: number; end: number }[] = [];
        let cursor = start;
        for (let k = 1; k < parts; k += 1) {
            const remaining = end - cursor;
            const remParts = parts - (k - 1);
            const minPart = Math.min(minWindow, (remaining / remParts) * 0.5);
            const lo = Math.max(cursor + minPart, end - (remParts - 1) * maxWindow);
            const hi = Math.min(cursor + maxWindow, end - (remParts - 1) * minPart);
            const ideal = cursor + remaining / remParts;
            const cutPoint = lo <= hi ? pickBestBoundary(ideal, lo, hi, cuts, segments) : Math.min(end, cursor + remaining / remParts);
            result.push({ start: cursor, end: cutPoint });
            cursor = cutPoint;
        }
        if (end - cursor > 0.001) result.push({ start: cursor, end });
        return result;
    };

    let best = buildParts(minParts);
    let bestSplits = countSentenceSplits(
        best.slice(0, -1).map((item) => item.end),
        segments,
    );
    if (bestSplits > 0 && minParts + 1 <= maxParts) {
        const alt = buildParts(minParts + 1);
        const altSplits = countSentenceSplits(
            alt.slice(0, -1).map((item) => item.end),
            segments,
        );
        if (altSplits < bestSplits) best = alt;
    }
    return best;
}

function pickBestBoundary(ideal: number, lo: number, hi: number, cuts: number[], segments: TranscriptSegment[]): number {
    const clampedIdeal = Math.min(hi, Math.max(lo, ideal));
    if (hi <= lo + 0.05) return clampedIdeal;
    const raw = [
        clampedIdeal,
        ...cuts.filter((time) => time >= lo && time <= hi),
        ...segments.flatMap((segment) => [segment.start, segment.end]).filter((time) => time >= lo && time <= hi),
    ];
    const candidates = Array.from(new Set(raw)).sort((a, b) => a - b);
    let best = clampedIdeal;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
        let score = -Math.abs(candidate - clampedIdeal) * 2;
        if (cuts.some((cut) => Math.abs(cut - candidate) <= 0.05)) score += 6;
        if (segments.some((segment) => Math.abs(segment.end - candidate) <= 0.6)) score += 5;
        if (segments.some((segment) => segment.start + 0.35 < candidate && candidate < segment.end - 0.35)) score -= 12;
        if (score > bestScore || (score === bestScore && Math.abs(candidate - clampedIdeal) < Math.abs(best - clampedIdeal))) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

function thinWindowFrames(allFrames: CopyFrame[], start: number, end: number, cuts: number[], maxCells: number): CopyFrame[] {
    const inside = allFrames.filter((frame) => frame.time >= start - 0.05 && frame.time <= end + 0.05);
    if (!inside.length) {
        const mid = (start + end) / 2;
        let closest = allFrames[0];
        let delta = Math.abs(closest.time - mid);
        for (const frame of allFrames) {
            const next = Math.abs(frame.time - mid);
            if (next < delta) {
                closest = frame;
                delta = next;
            }
        }
        return [closest];
    }
    if (inside.length <= maxCells) return inside;
    const windowCuts = cuts.filter((cut) => cut >= start - 0.05 && cut <= end + 0.05);
    const cutTimes = new Set<number>();
    for (const cut of windowCuts) {
        let bestFrame: CopyFrame | null = null;
        let bestDist = Infinity;
        for (const frame of inside) {
            const dist = Math.abs(frame.time - cut);
            if (dist <= 0.15 && dist < bestDist) {
                bestDist = dist;
                bestFrame = frame;
            }
        }
        if (bestFrame) cutTimes.add(bestFrame.time);
    }
    const cutFrames = inside.filter((frame) => cutTimes.has(frame.time));
    if (cutFrames.length >= maxCells) return sampleFrames(cutFrames, maxCells);
    const others = inside.filter((frame) => !cutTimes.has(frame.time));
    const thinned = sampleFrames(others, maxCells - cutFrames.length);
    const merged = [...cutFrames, ...thinned].sort((a, b) => a.time - b.time);
    return merged.filter((frame, index, list) => list.findIndex((other) => other.time === frame.time) === index);
}

export type PlanAnalysisWindowsOptions = {
    outline?: CopyOutlineUnit[];
    cuts?: number[];
    segments?: TranscriptSegment[];
    maxWindowSeconds?: number;
    minWindowSeconds?: number;
    maxCells?: number;
};

/**
 * 智能切窗：优先按第一步大纲、镜头切点与台词句末对齐切分（避免硬切在台词中间），
 * 缺失大纲或超长段时再按切点/句末约束细分到 [minWindowSeconds, maxWindowSeconds] 范围内。
 */
export function planAnalysisWindows(frames: CopyFrame[], duration: number, options: PlanAnalysisWindowsOptions = {}): CopyTimeWindow[] {
    const sorted = [...frames].sort((a, b) => a.time - b.time);
    if (!sorted.length || !Number.isFinite(duration) || duration <= 0) return [];
    const maxWindow = Math.max(5, options.maxWindowSeconds ?? 15);
    const minWindow = Math.min(maxWindow, Math.max(1, options.minWindowSeconds ?? 5));
    const maxCells = Math.max(1, options.maxCells ?? 18);
    const cuts = (options.cuts ?? []).filter((time) => Number.isFinite(time) && time > 0 && time < duration).sort((a, b) => a - b);
    const segments = (options.segments ?? []).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);

    if (duration <= maxWindow) {
        return [{ start: 0, end: duration, frames: thinWindowFrames(sorted, 0, duration, cuts, maxCells) }];
    }

    const parsedOutline = (options.outline ?? [])
        .map((unit) => ({ start: shotStartSeconds(unit.start), end: shotStartSeconds(unit.end) }))
        .filter((unit) => Number.isFinite(unit.start) && Number.isFinite(unit.end) && unit.end > unit.start)
        .map((unit) => ({ start: Math.max(0, unit.start), end: Math.min(duration, unit.end) }))
        .filter((unit) => unit.end > unit.start)
        .sort((a, b) => a.start - b.start);

    let covered = 0;
    let covStart = -1;
    let covEnd = -1;
    for (const unit of parsedOutline) {
        if (covStart < 0) {
            covStart = unit.start;
            covEnd = unit.end;
        } else if (unit.start <= covEnd) {
            covEnd = Math.max(covEnd, unit.end);
        } else {
            covered += covEnd - covStart;
            covStart = unit.start;
            covEnd = unit.end;
        }
    }
    if (covStart >= 0) covered += covEnd - covStart;

    let intervals: { start: number; end: number }[] = [];
    if (parsedOutline.length >= 1 && covered >= 0.7 * duration) {
        const rawPoints = parsedOutline
            .flatMap((unit) => [unit.start, unit.end])
            .filter((time) => time >= 0.5 && time <= duration - 0.5)
            .sort((a, b) => a - b);
        const deduped: number[] = [];
        for (const time of rawPoints) {
            if (!deduped.length || time - deduped[deduped.length - 1] >= 0.5) deduped.push(time);
        }
        const snapped: number[] = [];
        for (let i = 0; i < deduped.length; i += 1) {
            const prev = snapped.length ? snapped[snapped.length - 1] : 0;
            const next = i + 1 < deduped.length ? deduped[i + 1] : duration;
            const containing = segments.find((segment) => segment.start + 0.35 < deduped[i] && deduped[i] < segment.end - 0.35);
            const rawLo = containing ? Math.min(deduped[i] - 1.5, containing.start) : deduped[i] - 1.5;
            const rawHi = containing ? Math.max(deduped[i] + 1.5, containing.end) : deduped[i] + 1.5;
            const lo = Math.max(prev + 0.5, rawLo);
            const hi = Math.min(next - 0.5, rawHi);
            const chosen = lo <= hi ? pickBestBoundary(deduped[i], lo, hi, cuts, segments) : deduped[i];
            if (chosen - prev >= 0.5 && duration - chosen >= 0.5) snapped.push(chosen);
        }
        const points = [0, ...snapped, duration];
        for (let i = 0; i + 1 < points.length; i += 1) {
            intervals.push({ start: points[i], end: points[i + 1] });
        }

        // 合并过短区间（< minWindow 且合并较短邻窗后 <= maxWindow）
        for (;;) {
            let mergeIdx = -1;
            let shortestSpan = Infinity;
            for (let i = 0; i < intervals.length; i += 1) {
                const span = intervals[i].end - intervals[i].start;
                if (span < minWindow && span < shortestSpan) {
                    const leftOk = i > 0 && intervals[i].end - intervals[i - 1].start <= maxWindow;
                    const rightOk = i + 1 < intervals.length && intervals[i + 1].end - intervals[i].start <= maxWindow;
                    if (leftOk || rightOk) {
                        shortestSpan = span;
                        mergeIdx = i;
                    }
                }
            }
            if (mergeIdx < 0) break;
            const leftSpan = mergeIdx > 0 && intervals[mergeIdx].end - intervals[mergeIdx - 1].start <= maxWindow ? intervals[mergeIdx - 1].end - intervals[mergeIdx - 1].start : Infinity;
            const rightSpan = mergeIdx + 1 < intervals.length && intervals[mergeIdx + 1].end - intervals[mergeIdx].start <= maxWindow ? intervals[mergeIdx + 1].end - intervals[mergeIdx + 1].start : Infinity;
            if (leftSpan <= rightSpan) {
                intervals[mergeIdx - 1] = { start: intervals[mergeIdx - 1].start, end: intervals[mergeIdx].end };
                intervals.splice(mergeIdx, 1);
            } else {
                intervals[mergeIdx] = { start: intervals[mergeIdx].start, end: intervals[mergeIdx + 1].end };
                intervals.splice(mergeIdx + 1, 1);
            }
        }

        // 拆分超长区间（> maxWindow），遇整倍数无余量压句时尝试 +1 段以避开句中切分
        intervals = intervals.flatMap((interval) => splitLongInterval(interval.start, interval.end, minWindow, maxWindow, cuts, segments));
    } else {
        let cursor = 0;
        while (duration - cursor > maxWindow) {
            const remaining = duration - cursor;
            const maxAllowed = remaining < maxWindow + minWindow ? Math.max(1, remaining - minWindow) : maxWindow;
            const target = Math.min(maxAllowed, 12);
            const lo = cursor + Math.min(Math.max(minWindow, 9), maxAllowed);
            const hi = cursor + maxAllowed;
            let next = lo <= hi ? pickBestBoundary(cursor + target, lo, hi, cuts, segments) : cursor + maxAllowed;
            if (next <= cursor + 0.5) next = Math.min(duration, cursor + maxWindow);
            intervals.push({ start: cursor, end: next });
            cursor = next;
        }
        if (duration - cursor > 0.001) intervals.push({ start: cursor, end: duration });
    }

    return intervals.map((interval) => ({
        start: interval.start,
        end: interval.end,
        frames: thinWindowFrames(sorted, interval.start, interval.end, cuts, maxCells),
    }));
}

/**
 * 按时间窗切帧：从第一步的单元大纲出发，每窗 frames 帧连续覆盖一段时间。
 * 和按场景切不同，这里保证一窗只覆盖一段连续时间，分镜单元不会跨窗。
 */
export function groupFramesIntoWindows(frames: CopyFrame[], secondsPerWindow = 12, maxCells = 16): CopyFrame[][] {
    const sorted = [...frames].sort((a, b) => a.time - b.time);
    if (!sorted.length) return [];
    // 按**时长**切窗，不按帧数：短视频是 0.2 秒一帧，按帧数切会把 10 秒的片子拆成 4 个 3 秒的小窗，
    // 模型就没法在里面排出 5~15 秒的单元。窗内帧太多时再抽稀，保证单张宫格看得清。
    const windows: CopyFrame[][] = [];
    let current: CopyFrame[] = [];
    for (const frame of sorted) {
        if (current.length && frame.time - current[0].time >= secondsPerWindow) {
            windows.push(current);
            current = [];
        }
        current.push(frame);
    }
    if (current.length) windows.push(current);
    return windows.map((windowFrames) => sampleFrames(windowFrames, maxCells));
}

/** 取大纲里和本窗重叠的条目，作为窗口提示词的剧情上下文。 */
export function outlineForWindow(outline: CopyOutlineUnit[], start: number, end: number) {
    return outline
        .filter((unit) => shotStartSeconds(unit.end) >= start - 0.5 && shotStartSeconds(unit.start) <= end + 0.5)
        .map((unit) => `${unit.start}-${unit.end}：${unit.summary}`)
        .join("\n");
}

/** 均匀抽稀到 max 帧（保留首尾），给第一步的「全局视图」用。 */
export function sampleFrames(frames: CopyFrame[], max = 24): CopyFrame[] {
    if (max <= 0) return [];
    const sorted = [...frames].sort((a, b) => a.time - b.time);
    if (sorted.length <= max) return sorted;
    if (max === 1) return [sorted[0]];
    const picked: CopyFrame[] = [];
    for (let index = 0; index < max; index += 1) picked.push(sorted[Math.round((index * (sorted.length - 1)) / (max - 1))]);
    return picked.filter((frame, index, list) => list.findIndex((other) => other.time === frame.time) === index);
}

/** 合并多批分析结果：同名的角色/场景/物品只留一条（描述取更完整的），分镜按时间排序去重。 */
export function mergeBatchAnalyses(results: CopyAnalysis[]): CopyAnalysis {
    const valid = results.filter(Boolean);
    if (!valid.length) throw new Error("分析没有返回结果");
    if (valid.length === 1) return valid[0];
    const mergeList = (key: "roles" | "scenes" | "items") => {
        const merged: CopyItem[] = [];
        const index = new Map<string, number>();
        for (const result of valid) {
            for (const item of result[key] ?? []) {
                const name = String(item.name ?? "").trim();
                if (!name) continue;
                const existing = index.get(name);
                if (existing === undefined) {
                    index.set(name, merged.length);
                    merged.push({ ...item, name });
                } else if ((merged[existing].description ?? "").length < (item.description ?? "").length) {
                    merged[existing] = { ...merged[existing], description: item.description };
                }
            }
        }
        return merged;
    };
    const seenStarts = new Set<string>();
    const shots: CopyShot[] = [];
    for (const result of valid) {
        for (const shot of result.shots ?? []) {
            const key = String(shot.start ?? "").trim();
            if (key && seenStarts.has(key)) continue;
            if (key) seenStarts.add(key);
            shots.push(shot);
        }
    }
    shots.sort((a, b) => shotStartSeconds(a.start) - shotStartSeconds(b.start));
    const stamp = Date.now();
    const spaceContext = cleanOnScreenText(valid.find((result) => result.spaceContext)?.spaceContext ?? "");
    return {
        title: valid.find((result) => result.title)?.title ?? "",
        ratio: valid.find((result) => result.ratio)?.ratio ?? "",
        style: valid.find((result) => result.style)?.style ?? "",
        ...(spaceContext ? { spaceContext } : {}),
        roles: mergeList("roles"),
        scenes: mergeList("scenes"),
        items: mergeList("items"),
        shots: shots.map((shot, index) => ({ ...shot, id: `shot-${stamp}-${index}` })),
    };
}

/** 合并后再兜一层：后一个分镜的台词整段包含/被包含于前面某段时清空，避免同一段被写两遍。 */
export function dropRepeatedDialogue(analysis: CopyAnalysis): CopyAnalysis {
    const seen: string[] = [];
    const shots = analysis.shots.map((shot) => {
        const text = String(shot.dialogue || "").trim();
        if (!text) return shot;
        const repeated = seen.some((prev) => prev.length > 15 && (prev.includes(text) || text.includes(prev)));
        seen.push(text);
        return repeated ? { ...shot, dialogue: "" } : shot;
    });
    return { ...analysis, shots };
}

/** 时间码归一成秒：支持 "1:02.4"、"12.5秒"、"0.0秒"。 */
export function shotStartSeconds(value: string) {
    const text = String(value ?? "").trim();
    const clock = text.match(/(\d+):(\d+(?:\.\d+)?)/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const numeric = Number(text.replace(/[^0-9.]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * 修复早期数据里的 id 撞车：那时 roles/scenes/items 都用 `item-<stamp>-<index>`，
 * 三个分区的第 0 项是同一个 id，生成一张图会同时显示在三个地方，批量生成还会互相覆盖。
 *
 * 载入历史记录时跑一次：按分区重写 id，并给出「老 id → 新 id」的映射，
 * 素材表跟着迁移。同一个老 id 被多个分区占用的，图归第一个占用者（角色 → 场景 → 物品）。
 */
export function sanitizeItemIds(analysis: CopyAnalysis): { analysis: CopyAnalysis; remap: Record<string, string> } {
    const stamp = Date.now();
    const claimed = new Set<string>();
    const remap: Record<string, string> = {};
    const fix = (list: CopyItem[], section: "roles" | "scenes" | "items") =>
        list.map((item, index) => {
            const oldId = String(item.id ?? "");
            const newId = `${section}-${stamp}-${index}`;
            if (oldId) {
                if (!claimed.has(oldId) && remap[oldId] === undefined) remap[oldId] = newId;
                claimed.add(oldId);
            }
            return { ...item, id: newId };
        });
    return {
        analysis: {
            ...analysis,
            roles: fix(analysis.roles ?? [], "roles"),
            scenes: fix(analysis.scenes ?? [], "scenes"),
            items: fix(analysis.items ?? [], "items"),
        },
        remap,
    };
}

export type TermReplaceRule = { from: string; to: string };

export type TermReplaceOptions = {
    /** true（默认）：同时替换资产名/描述/声线与标题/风格/空间统一；false：仅替换分镜文案且保护 `@资产名` 引用不被破坏 */
    includeAssets?: boolean;
};

export type TermReplaceStats = {
    totalMatches: number;
    shotCount: number;
    assetCount: number;
};

function normalizeReplaceRules(rules: TermReplaceRule[]): TermReplaceRule[] {
    const dedup = new Map<string, TermReplaceRule>();
    for (const rule of rules) {
        const from = String(rule.from ?? "").trim();
        const to = String(rule.to ?? "").trim();
        if (!from || from === to) continue;
        dedup.set(from, { from, to });
    }
    return Array.from(dedup.values()).sort((a, b) => b.from.length - a.from.length);
}

function buildReplacePattern(rules: TermReplaceRule[]): { pattern: RegExp; map: Map<string, string> } | null {
    if (!rules.length) return null;
    const map = new Map(rules.map((rule) => [rule.from, rule.to]));
    const pattern = new RegExp(rules.map((rule) => escapeRegExp(rule.from)).join("|"), "g");
    return { pattern, map };
}

function applyPlainReplace(text: string, compiled: { pattern: RegExp; map: Map<string, string> }): { text: string; count: number } {
    if (!text) return { text, count: 0 };
    let count = 0;
    const next = text.replace(compiled.pattern, (matched) => {
        count += 1;
        return compiled.map.get(matched) ?? matched;
    });
    return { text: next, count };
}

function applyMentionSafeReplace(
    text: string,
    compiled: { pattern: RegExp; map: Map<string, string> },
    protectedAssetNames: string[],
): { text: string; count: number } {
    if (!text) return { text, count: 0 };
    if (!protectedAssetNames.length) return applyPlainReplace(text, compiled);
    let total = 0;
    const next = splitPromptAssetTokens(text, protectedAssetNames)
        .map((token) => {
            if (token.type === "mention") return token.raw;
            const res = applyPlainReplace(token.value, compiled);
            total += res.count;
            return res.text;
        })
        .join("");
    return { text: next, count: total };
}

function runTermReplace(
    analysis: CopyAnalysis,
    rules: TermReplaceRule[],
    options: TermReplaceOptions = {},
): { analysis: CopyAnalysis; stats: TermReplaceStats } {
    const normalized = normalizeReplaceRules(rules);
    const compiled = buildReplacePattern(normalized);
    if (!compiled) {
        return { analysis, stats: { totalMatches: 0, shotCount: 0, assetCount: 0 } };
    }
    const includeAssets = options.includeAssets !== false;
    let totalMatches = 0;
    let shotCount = 0;
    let assetCount = 0;

    let nextTitle = analysis.title;
    let nextStyle = analysis.style;
    let nextSpaceContext = analysis.spaceContext;
    let nextRoles = analysis.roles;
    let nextScenes = analysis.scenes;
    let nextItems = analysis.items;
    const renameBySection: Record<CopyAssetSection, Map<string, string>> = {
        roles: new Map(),
        scenes: new Map(),
        items: new Map(),
    };
    const protectedNames: string[] = [];

    if (includeAssets) {
        const titleRes = applyPlainReplace(analysis.title || "", compiled);
        if (titleRes.count > 0) {
            nextTitle = titleRes.text;
            totalMatches += titleRes.count;
            assetCount += 1;
        }
        const styleRes = applyPlainReplace(analysis.style || "", compiled);
        if (styleRes.count > 0) {
            nextStyle = styleRes.text;
            totalMatches += styleRes.count;
            assetCount += 1;
        }
        if (analysis.spaceContext) {
            const spaceRes = applyPlainReplace(analysis.spaceContext, compiled);
            if (spaceRes.count > 0) {
                nextSpaceContext = spaceRes.text;
                totalMatches += spaceRes.count;
                assetCount += 1;
            }
        }
        const replaceSection = (items: CopyItem[], section: CopyAssetSection) =>
            items.map((item) => {
                let itemMatches = 0;
                const rawNameRes = applyPlainReplace(item.name || "", compiled);
                const trimmedNextName = rawNameRes.text.trim();
                // 若整串资产名被替换为空（例如删除品牌词且该资产名本身就是品牌名），保留原 name 避免产生空名资产。
                let nextName = item.name;
                if (trimmedNextName) {
                    nextName = trimmedNextName;
                    itemMatches += rawNameRes.count;
                    if (nextName !== item.name) renameBySection[section].set(item.name, nextName);
                } else if (rawNameRes.count > 0 && item.name) {
                    protectedNames.push(item.name);
                }
                const descRes = applyPlainReplace(item.description || "", compiled);
                itemMatches += descRes.count;
                let nextVoice = item.voice;
                if (section === "roles" && item.voice) {
                    const voiceRes = applyPlainReplace(item.voice, compiled);
                    nextVoice = voiceRes.text;
                    itemMatches += voiceRes.count;
                }
                if (itemMatches > 0) {
                    totalMatches += itemMatches;
                    assetCount += 1;
                }
                return {
                    ...item,
                    name: nextName,
                    description: descRes.text,
                    ...(section === "roles" && nextVoice !== undefined ? { voice: nextVoice } : {}),
                };
            });
        nextRoles = replaceSection(analysis.roles, "roles");
        nextScenes = replaceSection(analysis.scenes, "scenes");
        nextItems = replaceSection(analysis.items, "items");
    } else {
        protectedNames.push(...[...analysis.roles, ...analysis.scenes, ...analysis.items].map((item) => item.name).filter(Boolean));
    }

    const replacePromptField = (value: string) =>
        protectedNames.length ? applyMentionSafeReplace(value, compiled, protectedNames) : applyPlainReplace(value, compiled);

    const nextShots = analysis.shots.map((shot) => {
        let shotMatches = 0;
        const videoRes = replacePromptField(shot.videoPrompt || "");
        const imageRes = replacePromptField(shot.imagePrompt || "");
        const descRes = applyPlainReplace(shot.description || "", compiled);
        const perfRes = applyPlainReplace(shot.performance || "", compiled);
        const soundRes = applyPlainReplace(shot.sound || "", compiled);
        const dialRes = applyPlainReplace(shot.dialogue || "", compiled);
        const textRes = applyPlainReplace(shot.onScreenText || "", compiled);
        shotMatches += videoRes.count + imageRes.count + descRes.count + perfRes.count + soundRes.count + dialRes.count + textRes.count;
        if (shotMatches > 0) {
            totalMatches += shotMatches;
            shotCount += 1;
        }
        const remapList = (list: string[], map: Map<string, string>) =>
            map.size ? Array.from(new Set(list.map((name) => map.get(name) ?? name).filter(Boolean))) : list;
        return {
            ...shot,
            videoPrompt: videoRes.text,
            imagePrompt: imageRes.text,
            description: descRes.text,
            performance: perfRes.text,
            sound: soundRes.text,
            dialogue: dialRes.text,
            onScreenText: textRes.text,
            ...(includeAssets
                ? {
                      roles: remapList(shot.roles ?? [], renameBySection.roles),
                      scenes: remapList(shot.scenes ?? [], renameBySection.scenes),
                      items: remapList(shot.items ?? [], renameBySection.items),
                  }
                : {}),
        };
    });

    return {
        analysis: {
            ...analysis,
            title: nextTitle,
            style: nextStyle,
            ...(nextSpaceContext !== undefined ? { spaceContext: nextSpaceContext } : {}),
            roles: nextRoles,
            scenes: nextScenes,
            items: nextItems,
            shots: nextShots,
        },
        stats: { totalMatches, shotCount, assetCount },
    };
}

/** 实时统计规则在当前分析结果中的命中次数，与 `replaceTermsInAnalysis` 共用同一遍历逻辑。 */
export function countAnalysisTermMatches(
    analysis: CopyAnalysis,
    rules: TermReplaceRule[],
    options: TermReplaceOptions = {},
): TermReplaceStats {
    return runTermReplace(analysis, rules, options).stats;
}

/** 批量替换全片提示词与可选的资产/全局设定（支持多组规则单遍最长优先替换）。 */
export function replaceTermsInAnalysis(
    analysis: CopyAnalysis,
    rules: TermReplaceRule[],
    options: TermReplaceOptions = {},
): { analysis: CopyAnalysis; stats: TermReplaceStats } {
    return runTermReplace(analysis, rules, options);
}
