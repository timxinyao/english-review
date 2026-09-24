import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../features/auth/api';

export function RequireAuth() {
  const { isLoading, isError } = useSession();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }
  if (isError) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
