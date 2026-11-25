import localforage from "localforage";

/**
 * 图片任务队列（项目级）。
 *
 * 图片任务化后，task id 必须在「提交成功的那一刻」就落盘：
 * 以前挂在节点上，既依赖当时哪个节点是 loading，又要等 1.5 秒防抖保存，
 * 刷新快一点就丢。这里改成项目级队列，提交即写，刷新后按队列续查。
 */
export type PendingImageTask = {
    projectId: string;
    taskId: string;
    model: string;
    prompt: string;
    createdAt: number;
};

const store = localforage.createInstance({ name: "huayou", storeName: "image_tasks" });
const KEY = "pending_image_tasks";

export async function listPendingImageTasks(): Promise<PendingImageTask[]> {
    return (await store.getItem<PendingImageTask[]>(KEY)) || [];
}

export async function enqueuePendingImageTask(entry: PendingImageTask): Promise<void> {
    const list = await listPendingImageTasks();
    if (list.some((item) => item.taskId === entry.taskId)) return;
    await store.setItem(KEY, [...list, entry]);
}

export async function removePendingImageTask(taskId: string): Promise<void> {
    const list = await listPendingImageTasks();
    const next = list.filter((item) => item.taskId !== taskId);
    if (next.length !== list.length) await store.setItem(KEY, next);
}
