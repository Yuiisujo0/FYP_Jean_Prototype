import { AlertCircle, ArrowRight, Bot, CheckCircle2, Database, Download, Info, LoaderCircle, Play, Send, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { explainStep } from '../../lib/explain';
import { errorCount } from '../../lib/validate';
import { downloadCsv } from './CheckPanel';
import { ApproveBox, NeedsYourEye, ReviewTotals } from './ReviewPanel';
import type { FlowEditor } from './useFlowEditor';

const RESULT_ROWS = 50;
const PREVIEW_ROWS = 5;

/** Step types that only read and reshape data in this browser. A workflow made of these is safe to run without asking. */
const SAFE_TYPES = new Set(['INPUT', 'READ_CSV', 'FILTER', 'TRANSFORM', 'OUTPUT']);
export const runsWithoutSideEffects = (editor: FlowEditor) => editor.ordered.length > 0 && editor.ordered.every(s => SAFE_TYPES.has(s.type));

function Section({ no, title, note, children }: { no: number; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rv__sec">
      <h2><span className="rv__no">{no}</span>{title}{note && <small>{note}</small>}</h2>
      {children}
    </section>
  );
}

/** "Not what you meant?": a change in plain words, made by the same AI as Ask. The answer is run again afterwards. */
function ChangeBox({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => Promise<{ text: string; ok: boolean }> }) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState<{ text: string; ok: boolean } | null>(null);
  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setReply(null);
    try {
      const out = await onSubmit(value);
      setReply(out);
      if (out.ok) setText('');
    } catch (e) {
      setReply({ text: e instanceof Error ? e.message : 'The change could not be made.', ok: false });
    }
  };
  return (
    <div className="rv__change">
      <label htmlFor="rv-change">Not what you meant? Say what to change.</label>
      <div className="rv__change-row">
        <input
          id="rv-change"
          className="input"
          value={text}
          placeholder="Only keep the name and fine columns…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void submit()}
        />
        <Button loading={busy} disabled={!text.trim()} icon={<Send size={15} />} onClick={submit}>Change</Button>
      </div>
      {reply && <p className={`rv__reply ${reply.ok ? 'is-ok' : ''}`} role="status">{reply.ok ? <CheckCircle2 size={15} aria-hidden /> : <Info size={15} aria-hidden />} {reply.text}</p>}
    </div>
  );
}

function TheAnswer({ editor, onRun, onShowSteps }: { editor: FlowEditor; onRun: () => void; onShowSteps: () => void }) {
  const { result, running, runError, issues, preview, stale } = editor;
  const errors = errorCount(issues);

  if (running) return <p className="check__hint"><LoaderCircle size={15} className="spin" aria-hidden /> Running it on your data…</p>;

  if (runError) {
    return (
      <div className="rv__problem" role="alert">
        <AlertCircle size={18} aria-hidden />
        <div>
          <b>It could not run</b>
          <p>{runError}</p>
          <div className="rv__actions">
            {runError.includes('No dataset matches') && <Link className="btn btn--primary btn--sm" to="/knowledge?tab=data"><Database size={15} aria-hidden /> Open Data library</Link>}
            <Button size="sm" icon={<Workflow size={15} />} onClick={onShowSteps}>See the steps</Button>
          </div>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <>
        <ReviewTotals editor={editor} />
        {result.columns.length > 0 && result.rows.length > 0 ? (
          <div className="rv__table">
            <table className="check__table">
              <thead><tr><th title="Row number in the source data">Row</th>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {result.rows.slice(0, RESULT_ROWS).map((r, i) => (
                  <tr key={i}><td>{result.lineage[i]?.join(', ') ?? i + 1}</td>{result.columns.map(c => <td key={c}>{r[c]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="check__hint">No rows in the result. If you expected some, check the steps below.</p>}
        {result.rows.length > RESULT_ROWS && <p className="check__hint">Showing the first {RESULT_ROWS} of {result.rows.length} rows. Download for all of them.</p>}
        <div className="rv__actions">
          {result.columns.length > 0 && <Button size="sm" icon={<Download size={15} />} onClick={() => downloadCsv(result, editor.name)}>Download CSV</Button>}
          <Button size="sm" variant={stale ? 'primary' : undefined} icon={<Play size={14} />} onClick={onRun}>Run again</Button>
        </div>
      </>
    );
  }

  if (errors) {
    return (
      <div className="rv__problem" role="alert">
        <AlertCircle size={18} aria-hidden />
        <div>
          <b>The steps have {errors === 1 ? 'an error' : 'errors'} to fix first</b>
          <p>{issues.find(i => i.level === 'ERROR')?.message}</p>
          <div className="rv__actions"><Button size="sm" icon={<Workflow size={15} />} onClick={onShowSteps}>Fix the steps</Button></div>
        </div>
      </div>
    );
  }

  // Not run yet: it saves a table or calls a web address, so it waits for the user. Show the dry-run preview meanwhile.
  return (
    <>
      <p className="check__hint">
        {editor.ordered.some(s => s.type === 'DATABASE') ? 'This workflow saves a table in your Data library'
          : editor.ordered.some(s => s.type === 'HTTP_REQUEST') ? 'This workflow calls a web address'
          : 'Some steps of this workflow do more than read and reshape data'}, so it runs only when you say so.
      </p>
      {preview.status === 'ready' && preview.result.columns.length > 0 && (
        <div className="rv__table">
          <table className="check__table">
            <thead><tr>{preview.result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{preview.result.rows.slice(0, PREVIEW_ROWS).map((r, i) => <tr key={i}>{preview.result.columns.map(c => <td key={c}>{r[c]}</td>)}</tr>)}</tbody>
          </table>
          <p className="check__hint">A preview of the first {Math.min(PREVIEW_ROWS, preview.result.rows.length)} of {preview.result.rows.length} rows. Nothing was saved.</p>
        </div>
      )}
      <div className="rv__actions"><Button variant="primary" icon={<Play size={14} />} onClick={onRun}>Run it</Button></div>
    </>
  );
}

interface Props {
  editor: FlowEditor;
  request: string;
  onRun: () => void;
  onShowSteps: () => void;
  onFocusNode: (id: string) => void;
  onRefine: (text: string) => Promise<{ text: string; ok: boolean }>;
}

/**
 * The purpose-first screen: the answer, what the AI understood, what needs a person's eye, then approve and download.
 * The canvas ("How it was done") is one click away for anyone who wants the steps.
 */
export function ResultView({ editor, request, onRun, onShowSteps, onFocusNode, onRefine }: Props) {
  const { result, gate, ordered, checks } = editor;
  const toReview = result ? result.exceptions.length + editor.assumptions.length : 0;

  return (
    <div className="rv">
      <div className="rv__inner">
        {request && (
          <p className="rv__request"><span>You asked</span>“{request}”</p>
        )}

        <Section no={1} title="The answer">
          <TheAnswer editor={editor} onRun={onRun} onShowSteps={onShowSteps} />
        </Section>

        <Section no={2} title="What the AI understood" note="the steps, in plain words">
          <ol className="check__explain rv__explain">
            {ordered.map(s => <li key={s.id}>{explainStep(s)}</li>)}
          </ol>
          {checks.length > 0 && (
            <details className="rv__checks">
              <summary><Bot size={14} aria-hidden /> Tested on your data {checks.length === 1 ? 'once' : `${checks.length} times`} after it was written</summary>
              <ol>{checks.map(c => <li key={c.round}>{c.detail}</li>)}</ol>
            </details>
          )}
          <ChangeBox busy={editor.refining} onSubmit={onRefine} />
          <button type="button" className="rv__link" onClick={onShowSteps}>See how it was done, step by step <ArrowRight size={14} aria-hidden /></button>
        </Section>

        {result && gate && (
          <>
            <Section no={3} title="What needs your eye" note={toReview ? undefined : 'nothing to decide'}>
              <NeedsYourEye editor={editor} onFocusNode={onFocusNode} />
            </Section>
            <Section no={4} title="Approve and download">
              <ApproveBox editor={editor} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
