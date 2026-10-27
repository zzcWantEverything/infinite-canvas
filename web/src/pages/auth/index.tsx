import { useState } from "react";
import { App, Button, Form, Input, Tabs } from "antd";
import { useNavigate } from "react-router-dom";

import { loginWithPassword, registerUser } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";

type FormValues = { baseUrl: string; username: string; password: string };

export default function AuthPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const setSession = useUserStore((state) => state.setSession);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const [loading, setLoading] = useState(false);
    const [tab, setTab] = useState<"login" | "register">("login");
    const [form] = Form.useForm<FormValues>();

    async function handleSubmit(values: FormValues) {
        const baseUrl = values.baseUrl.trim().replace(/\/+$/, "");
        setLoading(true);
        try {
            const result =
                tab === "login"
                    ? await loginWithPassword(baseUrl, values.username, values.password)
                    : await registerUser(baseUrl, values.username, values.password);
            setSession({ token: result.token, baseUrl, user: result.user });
            // 把 new-api 作为渠道自动注入 config，用 token 作为 apiKey
            importChannelCredentials({ baseUrl, apiKey: result.token });
            void message.success(tab === "login" ? "登录成功" : "注册成功");
            navigate("/");
        } catch (err) {
            void message.error(err instanceof Error ? err.message : "操作失败，请检查地址和账号信息");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="flex min-h-dvh items-center justify-center bg-background px-4">
            <div className="w-full max-w-sm">
                <div className="mb-8 text-center">
                    <span
                        className="mx-auto mb-3 block size-10 bg-foreground"
                        style={{
                            mask: "url(/logo.svg) center / contain no-repeat",
                            WebkitMask: "url(/logo.svg) center / contain no-repeat",
                        }}
                    />
                    <h1 className="text-xl font-semibold text-foreground">短视频生成平台</h1>
                </div>
                <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-700 dark:bg-stone-900">
                    <Tabs
                        activeKey={tab}
                        onChange={(key) => setTab(key as "login" | "register")}
                        centered
                        items={[
                            { key: "login", label: "登录" },
                            { key: "register", label: "注册" },
                        ]}
                        className="mb-2"
                    />
                    <Form form={form} layout="vertical" onFinish={handleSubmit} requiredMark={false}>
                        <Form.Item
                            name="baseUrl"
                            label="服务地址"
                            rules={[
                                { required: true, message: "请填写服务地址" },
                                {
                                    validator: (_, value) => {
                                        try {
                                            const url = new URL((value || "").trim());
                                            if (url.protocol === "http:" || url.protocol === "https:") return Promise.resolve();
                                        } catch {
                                            // ignore
                                        }
                                        return Promise.reject(new Error("请填写有效的 http/https 地址"));
                                    },
                                },
                            ]}
                        >
                            <Input placeholder="https://api.example.com" autoComplete="url" />
                        </Form.Item>
                        <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请填写用户名" }]}>
                            <Input placeholder="username" autoComplete="username" />
                        </Form.Item>
                        <Form.Item name="password" label="密码" rules={[{ required: true, message: "请填写密码" }]}>
                            <Input.Password placeholder="password" autoComplete={tab === "login" ? "current-password" : "new-password"} />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" block loading={loading} className="mt-1">
                            {tab === "login" ? "登录" : "注册"}
                        </Button>
                    </Form>
                </div>
            </div>
        </div>
    );
}
