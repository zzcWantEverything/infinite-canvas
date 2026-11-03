import { App, Button, Form, Input } from "antd";
import { Image, Link2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";

export function ConfigImgbed() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [testing, setTesting] = useState(false);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);

    const testImgbed = async () => {
        const url = (config.imgbedUrl || "").trim().replace(/\/+$/, "");
        if (!url) {
            message.error(t("config.imgbed.addressRequired"));
            return;
        }
        setTesting(true);
        try {
            const resp = await fetch(`${url}/health`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            if (json.ok) message.success(t("config.imgbed.available"));
            else throw new Error("health check failed");
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.imgbed.unreachable"));
        } finally {
            setTesting(false);
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Image className="size-4" />
                            {t("config.imgbed.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.imgbed.description")}</div>
                    </div>
                </div>
                <Form.Item label={t("config.imgbed.address")} extra={t("config.imgbed.addressDescription")} className="mt-3 mb-0">
                    <Input
                        value={config.imgbedUrl}
                        placeholder="http://119.45.0.224:8081"
                        onChange={(event) => updateConfig("imgbedUrl", event.target.value)}
                        prefix={<Link2 className="size-4 text-stone-400" />}
                    />
                </Form.Item>
                <Button className="mt-3" icon={<Link2 className="size-4" />} loading={testing} onClick={() => void testImgbed()}>
                    {t("config.imgbed.test")}
                </Button>
                <div className="mt-3 text-xs text-stone-500">{t("config.imgbed.usageHint")}</div>
            </section>
        </Form>
    );
}
