import { useEffect, useRef, useState } from "react";
import { App, Button, Form, Input, Tabs } from "antd";
import { useNavigate } from "react-router-dom";

import { fetchStatus, loginWithPassword, registerUser, sendVerificationCode, createDefaultApiKey, fetchUserTokens } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";

type LoginValues = { baseUrl: string; username: string; password: string };
type RegisterValues = { username: string; password: string; confirmPassword: string; email?: string; verificationCode?: string };

function getBaseUrl(formBaseUrl: string) {
    return import.meta.env.DEV
        ? (import.meta.env.VITE_API_BASE as string || "http://119.45.0.224:3000").replace(/\/+$/, "")
        : formBaseUrl.trim().replace(/\/+$/, "");
}

export default function AuthPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const setSession = useUserStore((state) => state.setSession);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const [loading, setLoading] = useState(false);
    const [tab, setTab] = useState<"login" | "register">("login");
    const [loginForm] = Form.useForm<LoginValues>();
    const [registerForm] = Form.useForm<RegisterValues>();

    // 注册：邮箱验证码相关
    const [emailVerificationRequired, setEmailVerificationRequired] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [countdown, setCountdown] = useState(0);
    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 进入注册 tab 时拉取后端状态，判断是否需要邮箱验证
    useEffect(() => {
        if (tab !== "register") return;
        const baseUrl = getBaseUrl(loginForm.getFieldValue("baseUrl") || "");
        fetchStatus(baseUrl)
            .then((status) => setEmailVerificationRequired(!!status.email_verification))
            .catch(() => { /* 忽略状态拉取失败 */ });
    }, [tab, loginForm]);

    function startCountdown() {
        setCountdown(60);
        countdownRef.current = setInterval(() => {
            setCountdown((c) => {
                if (c <= 1) {
                    clearInterval(countdownRef.current!);
                    return 0;
                }
                return c - 1;
            });
        }, 1000);
    }

    async function handleSendCode() {
        const email = registerForm.getFieldValue("email") as string | undefined;
        if (!email) {
            void message.warning("请先填写邮箱");
            return;
        }
        setSendingCode(true);
        try {
            const baseUrl = getBaseUrl(loginForm.getFieldValue("baseUrl") || "");
            await sendVerificationCode(baseUrl, email);
            void message.success("验证码已发送");
            startCountdown();
        } catch (err) {
            void message.error(err instanceof Error ? err.message : "发送失败");
        } finally {
            setSendingCode(false);
        }
    }

    async function handleLogin(values: LoginValues) {
        const baseUrl = getBaseUrl(values.baseUrl || "");
        setLoading(true);
        try {
            const result = await loginWithPassword(baseUrl, values.username, values.password);
            setSession({ token: result.token, baseUrl, user: result.user });
            // 检查是否已有 API Key，没有则自动创建一个默认的
            try {
                const tokens = await fetchUserTokens(baseUrl, result.token);
                const existingKey = tokens.find((t) => t.key)?.key;
                if (existingKey) {
                    importChannelCredentials({ baseUrl, apiKey: existingKey });
                } else {
                    const newKey = await createDefaultApiKey(baseUrl, result.token);
                    importChannelCredentials({ baseUrl, apiKey: newKey || result.token });
                }
            } catch {
                importChannelCredentials({ baseUrl, apiKey: result.token });
            }
            void message.success("登录成功");
            navigate("/");
        } catch (err) {
            void message.error(err instanceof Error ? err.message : "登录失败");
        } finally {
            setLoading(false);
        }
    }

    async function handleRegister(values: RegisterValues) {
        if (values.password !== values.confirmPassword) {
            void message.error("两次密码不一致");
            return;
        }
        const baseUrl = getBaseUrl(loginForm.getFieldValue("baseUrl") || "");
        setLoading(true);
        try {
            await registerUser(baseUrl, {
                username: values.username,
                password: values.password,
                email: values.email || undefined,
                verification_code: values.verificationCode || undefined,
            });
            void message.success("注册成功，请登录");
            setTab("login");
            loginForm.setFieldValue("username", values.username);
        } catch (err) {
            void message.error(err instanceof Error ? err.message : "注册失败");
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

                    {tab === "login" && (
                        <Form form={loginForm} layout="vertical" onFinish={handleLogin} requiredMark={false}>
                            {!import.meta.env.DEV && (
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
                                                } catch { /* ignore */ }
                                                return Promise.reject(new Error("请填写有效的 http/https 地址"));
                                            },
                                        },
                                    ]}
                                >
                                    <Input placeholder="https://api.example.com" autoComplete="url" />
                                </Form.Item>
                            )}
                            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请填写用户名" }]}>
                                <Input placeholder="用户名" autoComplete="username" />
                            </Form.Item>
                            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请填写密码" }]}>
                                <Input.Password placeholder="密码" autoComplete="current-password" />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" block loading={loading} className="mt-1">
                                登录
                            </Button>
                        </Form>
                    )}

                    {tab === "register" && (
                        <Form form={registerForm} layout="vertical" onFinish={handleRegister} requiredMark={false}>
                            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请填写用户名" }]}>
                                <Input placeholder="用户名" autoComplete="username" />
                            </Form.Item>
                            <Form.Item
                                name="password"
                                label="密码"
                                rules={[
                                    { required: true, message: "请填写密码" },
                                    { min: 8, message: "密码至少 8 位" },
                                ]}
                            >
                                <Input.Password placeholder="密码（至少 8 位）" autoComplete="new-password" />
                            </Form.Item>
                            <Form.Item
                                name="confirmPassword"
                                label="确认密码"
                                rules={[{ required: true, message: "请确认密码" }]}
                            >
                                <Input.Password placeholder="再次输入密码" autoComplete="new-password" />
                            </Form.Item>
                            <Form.Item
                                name="email"
                                label={emailVerificationRequired ? "邮箱（验证必填）" : "邮箱（选填）"}
                                rules={emailVerificationRequired ? [{ required: true, message: "请填写邮箱" }, { type: "email", message: "请填写有效邮箱" }] : [{ type: "email", message: "请填写有效邮箱" }]}
                            >
                                <Input placeholder="name@example.com" type="email" autoComplete="email" />
                            </Form.Item>
                            {emailVerificationRequired && (
                                <Form.Item name="verificationCode" label="邮箱验证码" rules={[{ required: true, message: "请填写验证码" }]}>
                                    <Input
                                        placeholder="验证码"
                                        suffix={
                                            <Button
                                                type="link"
                                                size="small"
                                                loading={sendingCode}
                                                disabled={countdown > 0}
                                                onClick={handleSendCode}
                                                className="!px-0"
                                            >
                                                {countdown > 0 ? `${countdown}s 后重发` : "发送验证码"}
                                            </Button>
                                        }
                                    />
                                </Form.Item>
                            )}
                            <Button type="primary" htmlType="submit" block loading={loading} className="mt-1">
                                注册
                            </Button>
                        </Form>
                    )}
                </div>
            </div>
        </div>
    );
}
