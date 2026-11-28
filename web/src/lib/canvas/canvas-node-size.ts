export const NODE_MIN_WIDTH = 220;
export const NODE_MIN_HEIGHT = 120;

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

/**
 * 画布里图片/视频节点默认按最小紧凑宽度落地：新建、拖入、上传、生成、助手插图统一对齐，
 * 高度按各自真实比例计算，用户后续可通过拖边框或四角放大。
 */
export const MEDIA_NODE_WIDTH = NODE_MIN_WIDTH;
export const MEDIA_NODE_DEFAULT_HEIGHT = Math.round((MEDIA_NODE_WIDTH * 9) / 16);
export const MEDIA_NODE_MAX_WIDTH = 480;
/** 极端长图/竖图的高度上限，超过就等比缩窄，避免出现比屏幕还高的节点。 */
export const MEDIA_NODE_MAX_HEIGHT = 480;

export function nodeSizeByWidth(width: number, height: number, targetWidth = MEDIA_NODE_WIDTH, maxHeight = MEDIA_NODE_MAX_HEIGHT) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    let boxWidth = Math.max(NODE_MIN_WIDTH, targetWidth);
    let boxHeight = (boxWidth * h) / w;
    if (boxHeight < NODE_MIN_HEIGHT) {
        boxHeight = NODE_MIN_HEIGHT;
        boxWidth = Math.min(MEDIA_NODE_MAX_WIDTH, (boxHeight * w) / h);
    }
    if (boxHeight > maxHeight) {
        boxWidth = Math.max(80, (boxWidth * maxHeight) / boxHeight);
        boxHeight = maxHeight;
    }
    return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
}

export function nodeSizeFromRatio(size: string, baseWidth = MEDIA_NODE_WIDTH, baseHeight = MEDIA_NODE_DEFAULT_HEIGHT) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return nodeSizeByWidth(width, height, baseWidth);
}
