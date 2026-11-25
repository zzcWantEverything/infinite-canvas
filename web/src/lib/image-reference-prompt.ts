import type { ReferenceImage } from "@/types/image";

import i18n from "@/i18n";

export function imageReferenceLabel(index: number) {
    return i18n.t("imageReferences.label", { index: index + 1 });
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[]) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return i18n.t("imageReferences.promptPrefix", { labels: labels.join(i18n.t("imageReferences.separator")), prompt: text });
}

/** 提示词里引用参考图的写法：画柚自己的「图片N」、中文习惯的「图N」、英文的「Image N」。 */
const IMAGE_REFERENCE_PATTERN = /(?:图片|图|image)\s*(\d+)/gi;

/**
 * 提示词里引用到的最大参考图编号；没有引用返回 0。
 * 上游（miniKey 等）会校验「编号 ≤ 实际收到的素材数」，越界直接 502，
 * 所以在发送前先比对一次，别白跑一趟还得自己翻译上游那句长文案。
 */
export function maxImageReferenceIndex(prompt: string) {
    let max = 0;
    for (const match of prompt.matchAll(IMAGE_REFERENCE_PATTERN)) {
        const index = Number(match[1]);
        // 「图片2024年度」这种不是编号引用：真实素材数远小于 100，超过就忽略。
        if (!Number.isFinite(index) || index > 100) continue;
        if (index > max) max = index;
    }
    return max;
}
