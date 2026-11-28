import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { deleteProjectsFromCloud } from "@/services/canvas-cloud-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useUserStore } from "@/stores/use-user-store";

export function CanvasDeleteProjectsDialog() {
    const { t } = useTranslation();
    const session = useUserStore((state) => state.session);
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const account = session?.user?.display_name || session?.user?.username || "-";
    const confirm = () => {
        const removingIds = [...ids];
        deleteProjects(removingIds);
        void deleteProjectsFromCloud(removingIds);
        cleanupImages();
        removeSelectedIds(removingIds);
        setDeleteIds([]);
    };

    return (
        <Modal
            title={t("canvas.project.deleteTitle")}
            open={ids.length > 0}
            centered
            onCancel={() => setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>{t("common.cancel")}</Button>
                    <Button danger type="primary" onClick={confirm}>
                        {t("common.delete")}
                    </Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">{t("canvas.project.deleteDescription", { count: ids.length, account })}</p>
        </Modal>
    );
}
