import localforage from "localforage";
import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    activeUserId: number | null;
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const LEGACY_CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
export const CANVAS_STORE_USER_PREFIX = "infinite-canvas:canvas_store:u:";
export const CANVAS_LEGACY_CLAIMED_KEY = "infinite-canvas:canvas_legacy_drafts_claimed";

export function canvasStoreKeyForUser(userId: number | null): string {
    return userId ? `${CANVAS_STORE_USER_PREFIX}${userId}` : "infinite-canvas:canvas_store:guest";
}

type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
type StoredCanvasEnvelope = { state?: Partial<PersistedCanvasState>; version?: number };

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirtyUserId: number | null = null;
let dirtyState: PersistedCanvasState | null = null;
let listenersRegistered = false;

function serializeCanvasState(state: PersistedCanvasState): string {
    return JSON.stringify({ state, version: 0 });
}

function parsePersistedCanvasEnvelope(raw: string | null): PersistedCanvasState | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as StoredCanvasEnvelope;
        const projects = Array.isArray(parsed?.state?.projects) ? parsed.state.projects : [];
        const deletedProjects = Array.isArray(parsed?.state?.deletedProjects) ? parsed.state.deletedProjects : [];
        return { projects, deletedProjects };
    } catch {
        return null;
    }
}

function ensureFlushListeners() {
    if (listenersRegistered || typeof window === "undefined") return;
    listenersRegistered = true;
    window.addEventListener("pagehide", () => {
        void flushCanvasLocalPersistence();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            void flushCanvasLocalPersistence();
        }
    });
}

function schedulePersist(userId: number | null, state: PersistedCanvasState) {
    if (userId === null) return;
    ensureFlushListeners();
    dirtyUserId = userId;
    dirtyState = state;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushCanvasLocalPersistence();
    }, 400);
}

/** 立即将当前账号尚未落盘的本地画布快照写入 IndexedDB（防抖期间切账号/关页用）。 */
export async function flushCanvasLocalPersistence(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (dirtyUserId === null || !dirtyState) return;
    const key = canvasStoreKeyForUser(dirtyUserId);
    const payload = serializeCanvasState(dirtyState);
    dirtyUserId = null;
    dirtyState = null;
    await localForageStorage.setItem(key, payload);
}

/** 按 userId 读取该账号独立的本地画布缓存。 */
export async function loadPersistedCanvasStateForUser(
    userId: number,
): Promise<{ exists: boolean; projects: CanvasProject[]; deletedProjects: CanvasDeletedProject[] }> {
    const raw = await localForageStorage.getItem(canvasStoreKeyForUser(userId));
    const parsed = parsePersistedCanvasEnvelope(raw);
    if (!parsed) return { exists: false, projects: [], deletedProjects: [] };
    return { exists: true, ...parsed };
}

/** 只读读取历史共享画布存储（用于升级后的按账号安全迁移，绝不清空历史键）。 */
export async function readLegacyCanvasProjects(): Promise<CanvasProject[]> {
    const raw = await localForageStorage.getItem(LEGACY_CANVAS_STORE_KEY);
    return parsePersistedCanvasEnvelope(raw)?.projects ?? [];
}

/** 将指定账号的画布列表加载到内存并持久化到该账号专属存储槽位。 */
export async function hydrateCanvasStoreForUser(
    userId: number,
    projects: CanvasProject[],
    deletedProjects: CanvasDeletedProject[] = [],
): Promise<void> {
    ensureFlushListeners();
    if (dirtyUserId === userId) {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        dirtyUserId = null;
        dirtyState = null;
    }
    useCanvasStore.setState({
        activeUserId: userId,
        hydrated: true,
        projects,
        deletedProjects,
    });
    await localForageStorage.setItem(canvasStoreKeyForUser(userId), serializeCanvasState({ projects, deletedProjects }));
}

/** 退出登录前刷盘并清空内存里的当前用户画布列表，避免同浏览器下一账号看到上一账号内容。 */
export async function resetCanvasStoreForLogout(): Promise<void> {
    await flushCanvasLocalPersistence();
    dirtyUserId = null;
    dirtyState = null;
    useCanvasStore.setState({
        activeUserId: null,
        hydrated: false,
        projects: [],
        deletedProjects: [],
    });
}

/** 汇总所有已持久化账号与历史缓存中的画布，避免在一个账号下清理未使用素材时误删另一账号的本地文件。 */
export async function collectAllPersistedCanvasProjects(): Promise<CanvasProject[]> {
    const collected: CanvasProject[] = [...useCanvasStore.getState().projects];
    const keysToRead = new Set<string>([LEGACY_CANVAS_STORE_KEY]);
    try {
        const allKeys = await localforage.keys();
        for (const key of allKeys) {
            if (key === LEGACY_CANVAS_STORE_KEY || key.startsWith(CANVAS_STORE_USER_PREFIX)) {
                keysToRead.add(key);
            }
        }
    } catch {
        if (typeof window !== "undefined") {
            for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key && (key === LEGACY_CANVAS_STORE_KEY || key.startsWith(CANVAS_STORE_USER_PREFIX))) {
                    keysToRead.add(key);
                }
            }
        }
    }
    await Promise.all(
        [...keysToRead].map(async (key) => {
            const raw = await localForageStorage.getItem(key);
            const parsed = parsePersistedCanvasEnvelope(raw);
            if (parsed?.projects.length) collected.push(...parsed.projects);
        }),
    );
    return collected;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
    activeUserId: null,
    hydrated: false,
    projects: [],
    deletedProjects: [],
    createProject: (title = i18n.t("canvas.project.untitled")) => {
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id,
            title,
            createdAt: now,
            updatedAt: now,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: initialViewport,
        };
        set((state) => {
            const projects = [project, ...state.projects];
            schedulePersist(state.activeUserId, { projects, deletedProjects: state.deletedProjects });
            return { projects };
        });
        return id;
    },
    importProject: (source) => {
        const now = new Date().toISOString();
        const project: CanvasProject = {
            id: nanoid(),
            title: source.title || i18n.t("canvas.project.imported"),
            createdAt: source.createdAt || now,
            updatedAt: now,
            nodes: source.nodes || [],
            connections: source.connections || [],
            chatSessions: source.chatSessions || [],
            activeChatId: source.activeChatId || null,
            backgroundMode: source.backgroundMode || "lines",
            showImageInfo: source.showImageInfo || false,
            viewport: source.viewport || initialViewport,
        };
        set((state) => {
            const projects = [project, ...state.projects];
            schedulePersist(state.activeUserId, { projects, deletedProjects: state.deletedProjects });
            return { projects };
        });
        return project.id;
    },
    openProject: (id) => {
        return get().projects.find((item) => item.id === id) || null;
    },
    renameProject: (id, title) =>
        set((state) => {
            const projects = state.projects.map((project) =>
                project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project,
            );
            schedulePersist(state.activeUserId, { projects, deletedProjects: state.deletedProjects });
            return { projects };
        }),
    deleteProjects: (ids) =>
        set((state) => {
            const now = new Date().toISOString();
            const removing = new Set(ids);
            const projects = state.projects.filter((project) => !removing.has(project.id));
            const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
            schedulePersist(state.activeUserId, { projects, deletedProjects });
            return { projects, deletedProjects };
        }),
    replaceProjects: (projects, deletedProjects = []) =>
        set((state) => {
            schedulePersist(state.activeUserId, { projects, deletedProjects });
            return { projects, deletedProjects };
        }),
    updateProject: (id, patch) =>
        set((state) => {
            const projects = state.projects.map((project) =>
                project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project,
            );
            schedulePersist(state.activeUserId, { projects, deletedProjects: state.deletedProjects });
            return { projects };
        }),
}));
