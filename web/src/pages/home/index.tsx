import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { App, Button, Image, Input } from "antd";
import { BookOpen, Image as ImageIcon, Sparkles, Video, Wand2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import i18n from "@/i18n";

type CreationMode = "image" | "video";

/** 即梦式首页：上方是唯一的创作入口，下面是瀑布流灵感墙。 */
export default function IndexPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const promptRef = useRef<HTMLDivElement>(null);
    const [prompt, setPrompt] = useState("");
    const [mode, setMode] = useState<CreationMode>("image");
    const [showcase, setShowcase] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [previewOpen, setPreviewOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // 提示词源都在 GitHub 上，网络不通时可能要等很久；骨架最多显示 8 秒就退回空态，避免一直转圈。
        const timer = window.setTimeout(() => setLoading(false), 8000);
        void fetchPrompts({ pageSize: 16 })
            .then((data) => {
                if (!cancelled) setShowcase(data.items);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : i18n.t("home.promptError")))
            .finally(() => {
                window.clearTimeout(timer);
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [message]);

    const submit = () => {
        const text = prompt.trim();
        navigate(text ? `/${mode}?prompt=${encodeURIComponent(text)}` : `/${mode}`);
    };

    const usePrompt = (text: string) => {
        setPrompt(text);
        promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
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

                <section className="mt-14">
                    <div className="mb-4 flex items-end justify-between gap-4">
                        <div>
                            <h2 className="text-lg font-semibold text-stone-950 sm:text-xl dark:text-stone-50">{t("home.inspiration")}</h2>
                            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("home.inspirationSubtitle")}</p>
                        </div>
                        <Button type="text" size="small" onClick={() => navigate("/prompts")} className="shrink-0 !text-stone-500 dark:!text-stone-400">
                            {t("home.viewAll")}
                        </Button>
                    </div>

                    {loading ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                            {Array.from({ length: 8 }).map((_, index) => (
                                <div key={index} className={cn("animate-pulse rounded-2xl bg-stone-200/70 dark:bg-stone-800", index % 3 === 0 ? "h-44" : "h-32")} />
                            ))}
                        </div>
                    ) : (
                        <div className="columns-2 gap-3 sm:columns-3 xl:columns-4">
                            {showcase.map((item, index) => (
                                <div key={item.id} className="group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl bg-stone-200/60 dark:bg-stone-800">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setPreviewIndex(index);
                                            setPreviewOpen(true);
                                        }}
                                        className="block w-full cursor-zoom-in"
                                        aria-label={item.title}
                                    >
                                        <img src={item.coverUrl} alt={item.title} loading="lazy" className="w-full object-cover transition duration-500 group-hover:scale-[1.02]" />
                                    </button>
                                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-black/0 to-black/0 opacity-0 transition group-hover:opacity-100" />
                                    <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1.5 p-3 opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                                        <p className="line-clamp-2 text-xs leading-5 text-white/90">{item.title}</p>
                                        <div className="mt-2 flex items-center justify-between gap-2">
                                            <div className="flex min-w-0 flex-wrap gap-1">
                                                {item.tags.slice(0, 2).map((tag) => (
                                                    <span key={tag} className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] leading-4 text-white backdrop-blur">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => usePrompt(item.prompt || item.title)}
                                                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-stone-900 transition hover:bg-white/90"
                                            >
                                                <Wand2 className="size-3" />
                                                {t("home.usePrompt")}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {!loading && !showcase.length ? (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-200 px-6 py-14 text-center dark:border-stone-800">
                            <p className="text-sm font-medium text-stone-600 dark:text-stone-300">{t("home.emptyInspiration")}</p>
                            <p className="max-w-md text-xs leading-5 text-stone-400 dark:text-stone-500">{t("home.emptyInspirationHint")}</p>
                        </div>
                    ) : null}
                </section>
            </div>

            <Image.PreviewGroup preview={{ open: previewOpen, current: previewIndex, onOpenChange: setPreviewOpen, onChange: setPreviewIndex }}>
                <div className="hidden">
                    {showcase.map((item) => (
                        <Image key={item.id} src={item.coverUrl} alt={item.title} />
                    ))}
                </div>
            </Image.PreviewGroup>
        </main>
    );
}
