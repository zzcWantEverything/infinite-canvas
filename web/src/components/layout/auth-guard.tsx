import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";

export function AuthGuard({ children }: { children: ReactNode }) {
    const session = useUserStore((state) => state.session);
    const { pathname } = useLocation();

    if (!session) {
        return <Navigate to="/auth" state={{ from: pathname }} replace />;
    }

    return <>{children}</>;
}
