import { AlertCircle, Database, RotateCcw, Upload, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { addSampleData } from '../../lib/samples';
import type { NoAnswer } from '../../lib/whyNoAnswer';
import { useWorkspace } from '../../state/WorkspaceContext';

interface Props {
  why: NoAnswer;
  /** The user's request, so "Build it again" can start from it. */
  request: string;
  onFocusNode: (id: string) => void;
  /** Called after sample data was added, so the screen can check the library again. */
  onDataAdded: () => Promise<void> | void;
  compact?: boolean;
}

/** Why there is no answer, in plain words, with the one or two things that fix it. Shown first, before any result. */
export function NoAnswerNotice({ why, request, onFocusNode, onDataAdded, compact }: Props) {
  const { notify } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const addSamples = async () => {
    setAdding(true);
    try {
      const added = await addSampleData();
      await onDataAdded();
      notify(`Added ${added} sample ${added === 1 ? 'table' : 'tables'} to your Data library`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not add the sample data.', { tone: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const rebuild = (
    <Link className="btn btn--secondary btn--sm" to="/generate" state={{ prompt: request, auto: true }}><RotateCcw size={15} aria-hidden /> Build it again</Link>
  );
  const upload = <Link className="btn btn--secondary btn--sm" to="/knowledge?tab=data"><Upload size={15} aria-hidden /> Upload a file</Link>;

  return (
    <div className={`noanswer ${why.kind === 'llm_step' ? 'is-warn' : ''} ${compact ? 'is-compact' : ''}`} role="alert">
      <AlertCircle size={20} aria-hidden />
      <div>
        <b>{why.title}</b>
        <p>{why.detail}</p>
        <div className="noanswer__actions">
          {why.kind === 'no_data' && (
            <>
              <Button size="sm" variant="primary" loading={adding} icon={<Database size={15} />} onClick={addSamples}>Add sample data</Button>
              {upload}
            </>
          )}
          {why.kind === 'no_source' && <>{request && rebuild}{upload}</>}
          {why.kind === 'missing_dataset' && (
            <>
              {/* A plan written for another table usually names that table's columns too, so building it again comes first. */}
              {request && (
                <Link className="btn btn--primary btn--sm" to="/generate" state={{ prompt: request, auto: true }}><RotateCcw size={15} aria-hidden /> Build it again</Link>
              )}
              {why.stepId && <Button size="sm" onClick={() => onFocusNode(why.stepId!)}>Choose a table</Button>}
              {upload}
            </>
          )}
          {why.kind === 'llm_step' && why.stepId && (
            <Button size="sm" icon={<Workflow size={15} />} onClick={() => onFocusNode(why.stepId!)}>Show me the step</Button>
          )}
        </div>
      </div>
    </div>
  );
}
