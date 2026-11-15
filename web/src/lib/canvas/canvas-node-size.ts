export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

/**
 * 画布里图片/视频节点统一宽度：拖入、上传、生成、助手插图都按这个宽度落地，
 * 高度按各自比例算。之前一律走 fitNodeSize（长边封顶 640/420 且不放大），
 * 结果拖进来的素材大图小图参差不齐，画布排布很乱。
 */
export const MEDIA_NODE_WIDTH = 340;
/** 极端长图/竖图的高度上限，超过就等比缩窄，避免出现比屏幕还高的节点。 */
export const MEDIA_NODE_MAX_HEIGHT = 640;

export function nodeSizeByWidth(width: number, height: number, targetWidth = MEDIA_NODE_WIDTH, maxHeight = MEDIA_NODE_MAX_HEIGHT) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    let boxHeight = (targetWidth * h) / w;
    let boxWidth = targetWidth;
    if (boxHeight > maxHeight) {
        boxWidth = (targetWidth * maxHeight) / boxHeight;
        boxHeight = maxHeight;
    }
    return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
