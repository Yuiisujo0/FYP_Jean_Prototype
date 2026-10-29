import { AlertTriangle, ArrowDownToLine, ArrowLeft, Check, CheckCircle2, Play, Table2, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { timeAgo } from '../../lib/format';
import { errorCount, warningCount } from '../../lib/validate';
import type { ValidationIssue } from '../../types';
import type { View } from './Editor';

interface Props {
  name: string;
  onName: (name: string) => void;
  updatedAt: number;
  issues: ValidationIssue[];
  running: boolean;
  onCheck: () => void;
  onExport: () => void;
  onRun: () => void;
  view: View;
  onView: (view: View) => void;
}

export function EditorToolbar({ name, onName, updatedAt, issues, running, onCheck, onExport, onRun, view, onView }: Props) {
  const errors = errorCount(issues);
  const warnings = warningCount(issues);
  const tone = errors ? 'danger' : warnings ? 'warn' : 'ok';
  const label = errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : 'Valid';

  return (
    <div className="etool">
      <Link to="/workflows" className="etool__back"><ArrowLeft size={16} aria-hidden /> <span>Workflows</span></Link>
      <span className="etool__sep" aria-hidden />
      <input className="etool__name" value={name} onChange={e => onName(e.target.value)} aria-label="Workflow name" />
      <span className="etool__saved"><Check size={14} aria-hidden /> Saved {timeAgo(updatedAt).toLowerCase()}</span>

      <div className="etool__spacer" />

      <Segmented<View>
        label="View"
        value={view}
        onChange={onView}
        options={[
          { value: 'result', label: 'Result', icon: <Table2 size={15} aria-hidden /> },
          { value: 'steps', label: 'How it was done', icon: <Workflow size={15} aria-hidden /> },
        ]}
      />

      <button type="button" className={`etool__valid is-${tone}`} onClick={onCheck} title="Open validation">
        {tone === 'ok' ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
        <span className="etool__valid-label">{label}</span>
      </button>
      <Button size="sm" icon={<ArrowDownToLine size={15} />} onClick={onExport}><span className="etool__label">Export</span></Button>
      <Button size="sm" variant="primary" loading={running} icon={<Play size={14} />} onClick={onRun}>{running ? 'Running' : 'Run'}</Button>
    </div>
  );
}
