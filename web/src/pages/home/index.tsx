import { useRef, useState, type KeyboardEvent } from "react";
import { Button, Input } from "antd";
import { BookOpen, Image as ImageIcon, Sparkles, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

type CreationMode = "image" | "video";

/** 即梦式首页：上方是唯一的创作入口，下面是瀑布流灵感墙。 */
export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const promptRef = useRef<HTMLDivElement>(null);
    const [prompt, setPrompt] = useState("");
    const [mode, setMode] = useState<CreationMode>("image");


    const submit = () => {
        const text = prompt.trim();
        navigate(text ? `/${mode}?prompt=${encodeURIComponent(text)}` : `/${mode}`);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
        }
    };

    const suggestions = [t("home.suggestion1"), t("home.suggestion2"), t("home.suggestion3"), t("home.suggestion4")];

    return (
        <main className="thin-scrollbar h-full overflow-y-auto bg-transparent">
            <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-6 sm:px-8 sm:pt-10">
                <div className="text-center">
                    <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-stone-950 sm:text-[40px] dark:text-stone-50">{t("home.heroTitle")}</h1>
                    <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-stone-500 dark:text-stone-400">{t("home.heroSubtitle")}</p>
                </div>

                <div ref={promptRef} className="mx-auto mt-7 max-w-[880px]">
                    <div className="rounded-[28px] border border-stone-200/80 bg-background p-4 shadow-[0_2px_24px_rgba(15,23,42,0.06)] transition focus-within:border-stone-300 sm:p-5 dark:border-stone-800 dark:shadow-[0_2px_24px_rgba(0,0,0,0.35)] dark:focus-within:border-stone-700">
                        <Input.TextArea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            onKeyDown={handleKeyDown}
                            variant="borderless"
                            autoSize={{ minRows: 3, maxRows: 7 }}
                            placeholder={t("home.promptPlaceholder")}
                            className="!p-0 !text-[15px] !leading-7 !text-stone-900 dark:!text-stone-100"
                        />

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                                <div className="flex items-center gap-0.5 rounded-full bg-stone-100 p-1 dark:bg-stone-800">
                                    {(["image", "video"] as const).map((item) => (
                                        <button
                                            key={item}
                                            type="button"
                                            onClick={() => setMode(item)}
                                            className={cn(
                                                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] leading-5 transition",
                                                mode === item ? "bg-background font-medium text-stone-950 shadow-sm dark:text-white" : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200",
                                            )}
                                        >
                                            {item === "image" ? <ImageIcon className="size-3.5" /> : <Video className="size-3.5" />}
                                            {t(item === "image" ? "home.modeImage" : "home.modeVideo")}
                                        </button>
                                    ))}
                                </div>
                                <Button type="text" size="small" icon={<BookOpen className="size-4" />} onClick={() => navigate("/prompts")} className="hidden !text-stone-500 sm:inline-flex dark:!text-stone-400">
                                    {t("workbench.viewPrompts")}
                                </Button>
                            </div>

                            <Button type="primary" size="large" shape="round" icon={<Sparkles className="size-4" />} onClick={submit} className="w-full !px-6 sm:w-auto">
                                {t("home.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="hide-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
                        {suggestions.map((text) => (
                            <button
                                key={text}
                                type="button"
                                onClick={() => setPrompt(text)}
                                className="shrink-0 whitespace-nowrap rounded-full border border-stone-200/80 bg-background/70 px-3.5 py-1.5 text-xs leading-5 text-stone-600 transition hover:border-stone-300 hover:bg-background hover:text-stone-900 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-400 dark:hover:border-stone-700 dark:hover:text-stone-100"
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                </div>

            </div>

        </main>
    );
}
