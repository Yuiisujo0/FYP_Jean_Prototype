import { AlertTriangle, Bot, CheckCircle2, Database, Download, LoaderCircle, Play, ShieldCheck, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { toCsv } from '../../lib/engine';
import { explainStep } from '../../lib/explain';
import { slug } from '../../lib/format';
import { errorCount } from '../../lib/validate';
import type { RunResult } from '../../types';
import type { FlowEditor } from './useFlowEditor';
import type { PreviewState } from './usePreview';
import { ReviewPanel } from './ReviewPanel';

const RESULT_ROWS = 50;
const PREVIEW_ROWS = 5;

function PreviewView({ preview, errors }: { preview: PreviewState; errors: number }) {
  if (errors > 0) return <p className="check__hint">Fix the errors above to see a preview.</p>;
  if (preview.status === 'idle' || preview.status === 'loading') {
    return <p className="check__hint"><LoaderCircle size={14} className="spin" aria-hidden /> Working out a preview…</p>;
  }
  if (preview.status === 'blocked') return <p className="check__hint">{preview.message}</p>;
  if (preview.status === 'failed') return <p className="check__error">The preview could not run. {preview.message}</p>;

  const { columns, rows, register, exceptions } = preview.result;
  if (!columns.length) return <p className="check__hint">This workflow produces no table yet.</p>;
  const critical = exceptions.filter(e => e.severity === 'critical').length;
  return (
    <>
      <p className="check__count"><b>{rows.length}</b> {rows.length === 1 ? 'row' : 'rows'} in the result{register ? ` (of ${register.total} read)` : ''}</p>
      {critical > 0 && (
        <p className="check__hint review__preview-note">
          <AlertTriangle size={14} aria-hidden /> {critical} {critical === 1 ? 'thing needs' : 'things need'} a decision, such as rows that could not be checked. Run it to review them.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="check__hint">No rows matched. Check the filter and the data.</p>
      ) : (
        <div className="check__scroll">
          <table className="check__table">
            <thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, PREVIEW_ROWS).map((r, i) => <tr key={i}>{columns.map(c => <td key={c}>{r[c]}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > PREVIEW_ROWS && <p className="check__hint">Showing the first {PREVIEW_ROWS}.</p>}
      <p className="check__hint">Is this what you asked for? If not, edit a step or use Ask.</p>
    </>
  );
}

export function downloadCsv(result: RunResult, name: string) {
  const blob = new Blob(['﻿', toCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(name)}-result.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  editor: FlowEditor;
  onRun: () => void;
  onFocusNode: (id: string) => void;
}

export function CheckPanel({ editor, onRun, onFocusNode }: Props) {
  const { issues, running, runs, result, runError, steps, ordered, preview } = editor;
  const errors = errorCount(issues);
  const total = steps.length;
  const done = Object.values(runs).filter(r => r.state === 'complete').length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const hasRun = Object.keys(runs).length > 0;

  return (
    <div className="panel">
      <div className={`check__status is-${errors ? 'danger' : issues.length ? 'warn' : 'ok'}`}>
        {errors ? <XCircle size={22} /> : issues.length ? <AlertTriangle size={22} /> : <CheckCircle2 size={22} />}
        <div>
          <b>{errors ? 'Needs attention' : issues.length ? 'Valid with warnings' : 'Ready to run'}</b>
          <small>{issues.length ? `${issues.length} ${issues.length === 1 ? 'check' : 'checks'} to review` : 'All structural checks passed'}</small>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="check__list">
          {issues.map((issue, i) => (
            <li key={i}>
              <button type="button" className={`check__item is-${issue.level.toLowerCase()}`} disabled={!issue.nodeId} onClick={() => issue.nodeId && onFocusNode(issue.nodeId)}>
                <span className="check__level">{issue.level === 'ERROR' ? 'Error' : 'Warning'}</span>
                {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="check__block">
        <h4>In plain English</h4>
        <ol className="check__explain">
          {ordered.map(s => <li key={s.id}>{explainStep(s)}</li>)}
        </ol>
      </section>

      {editor.checks.length > 0 && (
        <section className="check__block">
          <h4>Tested by running it <small>after it was generated</small></h4>
          <ol className="check__agent">
            {editor.checks.map(c => (
              <li key={c.round}>
                <Bot size={14} aria-hidden /> <span>{c.detail}</span>
                {c.sent && (
                  <details>
                    <summary>What was sent to the AI</summary>
                    <pre>{c.sent}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="check__block" aria-live="polite">
        <h4>Preview <small>nothing is saved or sent</small></h4>
        <PreviewView preview={preview} errors={errors} />
      </section>

      <Button variant="primary" className="check__run" loading={running} disabled={errors > 0} icon={<Play size={15} />} onClick={onRun}>
        {running ? 'Running…' : hasRun ? 'Run again' : 'Run workflow'}
      </Button>

      {hasRun && (
        <div className="check__run-panel">
          <div className="check__progress-head">
            <span>Run</span>
            <b>{runError ? 'Failed' : result ? 'Complete' : `${percent}%`}</b>
          </div>
          <div className="check__track"><i style={{ width: `${result ? 100 : percent}%` }} data-failed={runError ? '' : undefined} /></div>
          {runError && <p className="check__error">{runError}</p>}
          {runError.includes('No dataset matches') && (
            <Link className="btn btn--primary btn--sm" to="/knowledge?tab=data"><Database size={15} aria-hidden /> Open Data library</Link>
          )}
          {result && (
            <>
              <p className="check__done">{result.message}</p>
              {result.columns.length > 0 && (
                <>
                  <div className="check__scroll">
                    <table className="check__table">
                      <thead><tr><th title="Row number in the source data">Row</th>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>
                        {result.rows.slice(0, RESULT_ROWS).map((r, i) => (
                          <tr key={i}><td>{result.lineage[i]?.join(', ') ?? i + 1}</td>{result.columns.map(c => <td key={c}>{r[c]}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {result.rows.length > RESULT_ROWS && <p className="panel__note">Showing the first {RESULT_ROWS} of {result.rows.length} rows. Download for all of them.</p>}
                  <Button size="sm" icon={<Download size={15} />} onClick={() => downloadCsv(result, editor.name)}>Download CSV</Button>
                </>
              )}
              <ReviewPanel editor={editor} onFocusNode={onFocusNode} />
            </>
          )}
        </div>
      )}

      <p className="panel__note"><ShieldCheck size={15} aria-hidden /> Runs in your browser on the datasets in your Data library. Database steps save a table there; HTTP steps call the address from your browser.</p>
    </div>
  );
}
