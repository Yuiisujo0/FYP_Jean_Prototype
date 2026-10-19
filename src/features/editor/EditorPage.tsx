import { ReactFlowProvider } from '@xyflow/react';
import { FolderOpen } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/ui/EmptyState';
import { useWorkspace } from '../../state/WorkspaceContext';
import { Editor } from './Editor';

export function EditorPage() {
  const { id } = useParams();
  const { flows } = useWorkspace();
  const flow = flows.find(f => f.id === id);

  if (!flow) {
    return (
      <div className="page">
        <EmptyState
          icon={<FolderOpen size={24} />}
          title="Workflow not found"
          description="It may have been deleted, or it lives in a different browser."
          action={<Link to="/workflows" className="btn btn--primary">Back to workflows</Link>}
        />
      </div>
    );
  }

  // Keyed so switching workflows always starts from a clean editor state.
  return (
    <ReactFlowProvider>
      <Editor key={flow.id} flow={flow} />
    </ReactFlowProvider>
  );
}
