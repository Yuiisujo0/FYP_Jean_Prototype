import { Navigate, Route, Routes } from 'react-router-dom';
import { EditorPage } from './features/editor/EditorPage';
import { AppShell } from './layout/AppShell';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { GeneratePage } from './pages/generate/GeneratePage';
import { KnowledgePage } from './pages/knowledge/KnowledgePage';
import { ProfilePage } from './pages/profile/ProfilePage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { WorkflowsPage } from './pages/workflows/WorkflowsPage';
import { WorkspaceProvider } from './state/WorkspaceContext';

export function App() {
  return (
    <WorkspaceProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="generate" element={<GeneratePage />} />
          <Route path="workflows" element={<WorkflowsPage />} />
          <Route path="editor/:id" element={<EditorPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </WorkspaceProvider>
  );
}
