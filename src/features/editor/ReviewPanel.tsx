import { BadgeCheck, CircleAlert, FileSpreadsheet, Lock, TriangleAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { slug } from '../../lib/format';
import { canAccept, MIN_REASON } from '../../lib/review';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { RunException } from '../../types';
import type { FlowEditor } from './useFlowEditor';

const MAX_ROWS_SHOWN = 12;
const rowsText = (rows: number[]) =>
  rows.length > MAX_ROWS_SHOWN ? `${rows.slice(0, MAX_ROWS_SHOWN).join(', ')} and ${rows.length - MAX_ROWS_SHOWN} more` : rows.join(', ');
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function download(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function AcceptForm({ onAccept }: { onAccept: (note: string) => void }) {
  const [note, setNote] = useState('');
  const ok = note.trim().length >= MIN_REASON;
  return (
    <div className="review__accept">
      <textarea className="input" rows={2} value={note} placeholder="Why is it fine to leave these as they are? (or fix the workflow and run again)" onChange={e => setNote(e.target.value)} aria-label="Reason for accepting" />
      <Button size="sm" disabled={!ok} onClick={() => onAccept(note.trim())}>Accept with this reason</Button>
    </div>
  );
}

function ExceptionItem({ e, editor, onFocusNode }: { e: RunException; editor: FlowEditor; onFocusNode: (id: string) => void }) {
  const note = editor.decisions.accepted[e.id];
  const critical = e.severity === 'critical';
  return (
    <li className={`review__ex is-${e.severity}${critical && note ? ' is-resolved' : ''}`}>
      <div className="review__ex-head">
        <span className="check__level">{critical ? (note ? 'Accepted' : 'Critical') : 'Warning'}</span>
        <button type="button" className="review__step" onClick={() => onFocusNode(e.stepId)}>{e.stepName}</button>
      </div>
      <p>{e.message}</p>
      {e.rows.length > 0 && <p className="review__rows">Source {e.rows.length === 1 ? 'row' : 'rows'}: {rowsText(e.rows)}</p>}
      {critical && !canAccept(e) && <p className="check__error">This cannot be accepted. Fix the workflow and run it again.</p>}
      {critical && canAccept(e) && (note
        ? <p className="review__accepted">Reason: {note} <button type="button" className="review__undo" onClick={() => editor.reopenException(e.id)}><Undo2 size={13} aria-hidden /> Undo</button></p>
        : <AcceptForm onAccept={text => editor.acceptException(e.id, text)} />)}
    </li>
  );
}

/** The review of a run's result: totals, exceptions, assumptions, approval and the report. */
export function ReviewPanel({ editor, onFocusNode }: { editor: FlowEditor; onFocusNode: (id: string) => void }) {
  const { profile } = useWorkspace();
  const [approver, setApprover] = useState(profile.name);
  const [approving, setApproving] = useState(false);
  const [message, setMessage] = useState('');
  const { result, gate, assumptions, decisions, stale, approval, approvalCurrent, approvalForResult } = editor;
  if (!result || !gate) return null;
  const reg = result.register;
  const critical = result.exceptions.filter(e => e.severity === 'critical');
  const warnings = result.exceptions.filter(e => e.severity === 'warning');

  const doApprove = async () => {
    setApproving(true);
    setMessage('');
    try {
      await editor.approveResult(approver);
      setMessage('Approved. The report now says so, with fingerprints of the workflow, the input and the result.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not approve.');
    } finally {
      setApproving(false);
    }
  };

  const report = () => {
    const bytes = editor.reportBytes();
    if (bytes) download(bytes, `${slug(editor.name)}-report.xlsx`);
  };

  return (
    <section className="check__block review" aria-label="Review">
      <h4>Review <small>before anyone relies on this result</small></h4>

      {stale && <p className="review__stale"><TriangleAlert size={15} aria-hidden /> The workflow changed after this run. Run it again to review the new result.</p>}

      {reg ? (
        <p className={`review__totals ${reg.balanced ? 'is-ok' : 'is-bad'}`}>
          Read <b>{reg.total}</b> rows from {reg.source}: <b>{reg.kept}</b> in the result, <b>{reg.excluded}</b> left out by the steps,{' '}
          <b>{reg.flagged}</b> flagged. {reg.balanced ? 'Every row is accounted for.' : 'The totals do not add up.'}
        </p>
      ) : <p className="check__hint">This workflow reads no data, so there are no rows to account for.</p>}

      {critical.length + warnings.length > 0 ? (
        <ul className="review__list">
          {[...critical, ...warnings].map(e => <ExceptionItem key={e.id} e={e} editor={editor} onFocusNode={onFocusNode} />)}
        </ul>
      ) : <p className="check__hint">No exceptions: nothing was left unchecked or skipped.</p>}

      {assumptions.length > 0 && (
        <div className="review__assume">
          <p className="review__label">Confirm what the workflow assumes</p>
          {assumptions.map(a => (
            <label key={a.id} className="review__check">
              <input type="checkbox" checked={!!decisions.confirmed[a.id]} onChange={e => editor.confirmAssumption(a.id, e.target.checked)} />
              <span>{a.text}</span>
            </label>
          ))}
        </div>
      )}

      {approval && approvalCurrent !== null && (
        <p className={`review__approval ${approvalCurrent ? 'is-ok' : 'is-old'}`}>
          <BadgeCheck size={16} aria-hidden />
          <span>
            Approved by <b>{approval.approver}</b> on {when(approval.approvedAt)}.{' '}
            {!approvalCurrent ? 'The workflow has changed since, so that approval no longer applies.'
              : approvalForResult ? 'It is the result shown here.' : 'The result shown here is different (the data may have changed), so review and approve it again.'}
          </span>
        </p>
      )}

      {!approvalForResult && (
        <div className="review__gate">
          {gate.blockers.length > 0 && (
            <ul className="review__blockers">
              {gate.blockers.map(b => <li key={b}><Lock size={13} aria-hidden /> {b}</li>)}
            </ul>
          )}
          <div className="review__approve">
            <input className="input" value={approver} onChange={e => setApprover(e.target.value)} placeholder="Your name" aria-label="Approver name" />
            <Button variant="primary" size="sm" disabled={!gate.canApprove || !approver.trim()} loading={approving} icon={<BadgeCheck size={15} />} onClick={doApprove}>
              Approve result
            </Button>
          </div>
        </div>
      )}
      {message && <p className="check__hint" role="status"><CircleAlert size={14} aria-hidden /> {message}</p>}

      <Button size="sm" icon={<FileSpreadsheet size={15} />} onClick={report}>
        Download report (Excel){approvalForResult ? '' : ', draft'}
      </Button>
    </section>
  );
}
