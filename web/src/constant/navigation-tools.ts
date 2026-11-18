import { Clapperboard, FileText, Image as ImageIcon, Images, Maximize2, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "image",
        icon: ImageIcon,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "copy",
        icon: Clapperboard,
    },
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
