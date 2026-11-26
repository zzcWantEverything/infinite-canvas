/**
 * 角色样式：同一个角色，按不同版式/用途生成参考图。
 * 每一种本质上是**一套提示词 + 一个画幅**，生图时和角色名/描述词/全片风格拼在一起。
 *
 * 维护方式：新增样式只要在 CHARACTER_STYLES 里加一项（id / 画幅 / i18n key / prompt），
 * 下拉、卡片画幅、生图提示词都会自动跟上；提示词里用到的变量见 CharacterPromptInput。
 */

/** 所有生成图通用的收尾约束：模型很容易自己往画面里加标题、水印、标签。 */
export const NO_TEXT_RULE = "画面中不要出现任何文字：不要标题、字幕、标签、说明文字、水印、Logo、品牌名和乱码。";

/** 场景图：只要环境，不要人。 */
export const SCENE_RULE = "只表现场景本身：画面中不要出现任何人物、人体、面部、手部或动物，也不要有任何文字；构图保持空旷，方便后期把角色放进去。";

/** 物品图：只要这一件物品。 */
export const ITEM_RULE = "只展示当前这一件物品本体：主体完整、清晰、无遮挡，画面中不要出现人物、手部、动物、其他物品和复杂场景，背景简洁，也不要文字。";

export type CharacterPromptInput = {
    /** 角色名 */
    name: string;
    /** 角色描述（外观、服装、发型等） */
    description: string;
    /** 全片风格（分析结果里的 style） */
    filmStyle: string;
};

export type CharacterStyle = {
    id: string;
    /** i18n key：下拉里显示的名字 */
    nameKey: string;
    /** i18n key：下拉里名字下面那行说明 */
    descriptionKey: string;
    /** 该样式默认出图比例，角色卡片也按这个比例展示 */
    aspectRatio: string;
    /** 生图提示词模板 */
    prompt: (input: CharacterPromptInput) => string;
};

const finish = (lines: (string | false)[]) => lines.filter(Boolean).join("\n");

export const CHARACTER_STYLES: CharacterStyle[] = [
    {
        id: "sheet",
        nameKey: "copyVideo.characterStyles.sheet.name",
        descriptionKey: "copyVideo.characterStyles.sheet.description",
        aspectRatio: "16:9",
        prompt: ({ name, description, filmStyle }) =>
            finish([
                "生成同一角色的人物资产图（character sheet），一版四格并排：正面全身、3/4 侧面全身、背面全身、面部特写。",
                "四格必须是同一个人：五官、发型、体型、服装结构与配饰完全一致，只是视角不同；四格清晰度、色调和质感统一。",
                "纯白无缝背景，没有环境、地面线、投影和展示台；正面柔和均匀打光，五官与服装清楚可辨。",
                `角色：${name}。${description}`,
                filmStyle && `风格：${filmStyle}`,
                "版式干净规整，画面中不要出现任何文字、标签、色卡文字、水印或 Logo。",
            ]),
    },
    {
        id: "fourView",
        nameKey: "copyVideo.characterStyles.fourView.name",
        descriptionKey: "copyVideo.characterStyles.fourView.description",
        aspectRatio: "3:4",
        prompt: ({ name, description, filmStyle }) =>
            finish([
                "生成同一角色的四视图设定稿，竖幅排版：上方一张正面脸部特写，下方从左到右依次是正面全身、正侧面全身、背面全身。",
                "四个视图的人物比例、五官、发型、服装结构与配色必须一致，光线方向统一，明暗和材质表现一致。",
                "纯白无缝背景，无地面线、无投影、无环境杂物；边缘可以放一组无文字的服装色卡色块。",
                `角色：${name}。${description}`,
                filmStyle && `风格：${filmStyle}`,
                "除色块外不要出现任何文字、说明、标签、水印或 Logo。",
            ]),
    },
    {
        id: "concept",
        nameKey: "copyVideo.characterStyles.concept.name",
        descriptionKey: "copyVideo.characterStyles.concept.description",
        aspectRatio: "16:9",
        prompt: ({ name, description, filmStyle }) =>
            finish([
                "生成该角色的概念设计图：主视觉是正面到半身的完整造型，旁边用两到三处放大细节补充服装材质、配饰、发型和鞋子。",
                "强调角色的整体气质、设计语言和服装细节，构图有设计感但始终以角色为主体，细节图与主视觉是同一个角色。",
                "简洁的浅色摄影棚背景，柔和布光，画面干净。",
                `角色：${name}。${description}`,
                filmStyle && `风格：${filmStyle}`,
                "不要出现文字、参数标注、标签、水印或 Logo。",
            ]),
    },
    {
        id: "closeup",
        nameKey: "copyVideo.characterStyles.closeup.name",
        descriptionKey: "copyVideo.characterStyles.closeup.description",
        aspectRatio: "16:9",
        prompt: ({ name, description, filmStyle }) =>
            finish([
                "生成该角色的特写三视图，三格等宽并排：正面脸部特写、3/4 侧脸特写、眼部与耳饰发丝细节特写。",
                "强调五官结构、皮肤质感、眼神和发丝层次，表情自然统一；三格是同一个人的同一套妆造。",
                "纯白或极浅灰背景，柔和正面光，三格清晰度和色调一致。",
                `角色：${name}。${description}`,
                filmStyle && `风格：${filmStyle}`,
                "不要出现文字、标签、水印或 Logo。",
            ]),
    },
];

export const DEFAULT_CHARACTER_STYLE = CHARACTER_STYLES[0].id;

export function characterStyleOf(id: string | undefined): CharacterStyle {
    return CHARACTER_STYLES.find((style) => style.id === id) ?? CHARACTER_STYLES[0];
}

/** 角色生图提示词：选中的样式模板 + 角色信息 + 全片风格 + 通用禁文字约束。 */
export function characterImagePrompt(input: CharacterPromptInput & { styleId?: string }): string {
    return `${characterStyleOf(input.styleId).prompt(input)}
${NO_TEXT_RULE}`;
}
