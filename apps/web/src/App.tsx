import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './app/shell';
import { RequireAuth } from './app/RequireAuth';
import { LoginPage } from './features/auth/LoginPage';
import { TodayPage } from './features/today/TodayPage';
import { LibraryPage } from './features/library/LibraryPage';
import { LibraryDetailPage } from './features/library/LibraryDetailPage';
import { ReadPage } from './features/read/ReadPage';
import { TokensPage } from './features/tokens/TokensPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { StatsPage } from './features/stats/StatsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/today" element={<TodayPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/:id" element={<LibraryDetailPage />} />
          <Route path="/read" element={<ReadPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/stats" element={<StatsPage />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate to="/today" replace />} />
      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}
