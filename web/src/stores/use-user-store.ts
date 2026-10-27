import { create } from "zustand";
import { persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { fetchCurrentUser, type NewApiUser } from "@/services/api/auth";

export type UserSession = {
    token: string;
    baseUrl: string;
    user: NewApiUser;
};

type UserStore = {
    session: UserSession | null;
    hydrated: boolean;
    setSession: (session: UserSession) => void;
    refreshUser: () => Promise<void>;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            session: null,
            hydrated: false,
            setSession: (session) => set({ session }),
            refreshUser: async () => {
                const { session } = get();
                if (!session) return;
                const user = await fetchCurrentUser(session.baseUrl, session.token);
                set({ session: { ...session, user } });
            },
            clearSession: () => set({ session: null }),
        }),
        {
            name: "infinite-canvas:user_session",
            storage: localForageStorage as Parameters<typeof persist>[1]["storage"],
            onRehydrateStorage: () => () => {
                // 必须用 setState 触发 React 重渲染，直接赋值不生效
                useUserStore.setState({ hydrated: true });
            },
        },
    ),
);
