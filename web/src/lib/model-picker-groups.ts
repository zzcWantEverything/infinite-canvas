// 模型下拉框的分组规则。
//
// 目录里真正的卡片是 variant_group：几条线路名共享一张卡片，下拉框拿卡片名当分组标题
// （sd 2.5 / sd 2.0 / sd 2.0 Fast …）。但运营大多不建 variant_group，而是直接把分组写进
// 展示名 ——「高清视觉 · sd2.5 1080P」「近期上新 · sd2.5-V 720P」。
//
// 这种名字以前原样平铺在列表里，同一个前缀重复出现好几次（高清视觉 ×3、全能参考 ×4），
// 看上去是一堆互不相干的模型。这里把展示名在第一个「 · 」处切开当分组用，视觉效果与
// 真正的 variant_group 卡片一致：前缀做标题，剩下半截做条目名。
//
// 只做展示分组，不改取值：条目 value 仍是「渠道::模型名」，路由与计费不受影响。

/** 一条下拉项在目录里的元数据；目录没拉到（或模型没进目录）时 card / variantDisplayName 为 null。 */
export type ModelPickerOptionMeta = {
    /** 下拉框的取值，通常是「渠道::模型名」。 */
    value: string;
    /** 纯模型名，目录缺失时用它兜底做标题。 */
    name: string;
    /** 所属的 variant_group 卡片；单线路模型也是一张只有一条线路的卡片。 */
    card: { key: string; displayName: string; variantCount: number } | null;
    /** 这条线路在目录里的展示名。 */
    variantDisplayName: string | null;
};

export type ModelPickerGroup = {
    key: string;
    /** 分组标题；header 为 false 时改用整串展示名，这里只是兜底值。 */
    label: string;
    /** 是否需要渲染标题。单条目且名字已经能自解释时不加，避免每条都顶一个小标题。 */
    header: boolean;
    /** label 缺省时由调用方回退到完整展示名。 */
    items: Array<{ value: string; label?: string }>;
};

const DISPLAY_SEPARATOR = " · ";

/**
 * 把「分组 · 线路名」切成两半。没有分隔符、分隔符在开头或某一半为空时返回 null ——
 * 那种名字（如「Seedance 2.5 官渠」）本来就该整串显示。
 */
export function splitModelDisplayName(displayName: string) {
    const index = displayName.indexOf(DISPLAY_SEPARATOR);
    if (index <= 0) return null;
    const label = displayName.slice(0, index).trim();
    const rest = displayName.slice(index + DISPLAY_SEPARATOR.length).trim();
    return label && rest ? { label, rest } : null;
}

/**
 * 按「variant_group 卡片 → 展示名前缀 → 自身」的优先级把下拉项归组。
 * 顺序沿用入参顺序：第一条出现的项决定该组在列表里的位置。
 */
export function groupModelOptions(options: ModelPickerOptionMeta[]): ModelPickerGroup[] {
    const groups = new Map<string, { key: string; label: string; items: Array<{ value: string; label?: string }> }>();

    for (const option of options) {
        // 多线路卡片：卡片名就是分组，线路名交给条目。单线路卡片的卡片名和线路名是同一串字，
        // 这时才去看展示名里有没有「分组 · 线路名」的写法。
        const split = option.card && option.card.variantCount <= 1 ? splitModelDisplayName(option.card.displayName) : null;
        // 前缀分组单独加前缀，避免和同名的 variant_group 卡片撞车。
        const key = split ? `prefix:${split.label}` : option.card?.key || option.name;
        const item = { value: option.value, label: split ? split.rest : (option.variantDisplayName ?? undefined) };
        const existing = groups.get(key);
        if (existing) {
            existing.items.push(item);
            continue;
        }
        groups.set(key, { key, label: split ? split.label : option.card?.displayName || option.name, items: [item] });
    }

    return Array.from(groups.values()).map((group) => {
        const [first] = group.items;
        // 单条目时，标题写的就是它自己的名字，加标题只是多占一行。
        const header = group.items.length > 1 || (first.label !== undefined && first.label !== group.label);
        return { ...group, header };
    });
}
