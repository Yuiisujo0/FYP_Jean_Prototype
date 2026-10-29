import { AlertCircle, ArrowRight, CheckCircle2, Info, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';

const PRESETS = [
  'Add a step that keeps only the first 10 rows',
  'Sort the result so the newest date comes first',
  'Remove the step that saves to the table',
];

type Reply = { text: string; tone: 'ok' | 'info' | 'error' };

export function AskPanel({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => Promise<{ text: string; ok: boolean }> }) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setReply(null);
    try {
      const result = await onSubmit(value);
      setReply({ text: result.text, tone: result.ok ? 'ok' : 'info' });
      if (result.ok) setText('');
    } catch (e) {
      setReply({ text: e instanceof Error ? e.message : 'The change could not be made.', tone: 'error' });
    }
  };

  const Icon = reply?.tone === 'ok' ? CheckCircle2 : reply?.tone === 'error' ? AlertCircle : Info;

  return (
    <div className="panel">
      <h3 className="panel__title">Ask jwork</h3>
      <p className="panel__lead">Describe a change in plain language and the workflow on the canvas updates.</p>

      {reply && <div className={`ask__reply ask__reply--${reply.tone}`} role="status"><Icon size={16} aria-hidden /> <span>{reply.text}</span></div>}

      <div className="field">
        <label className="field__label" htmlFor="ask-input">Your change</label>
        <textarea
          id="ask-input"
          className="textarea"
          rows={4}
          value={text}
          placeholder="Add a step that keeps only the name and fine columns…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
        />
      </div>
      <Button variant="primary" loading={busy} disabled={!text.trim()} icon={<Send size={15} />} onClick={submit}>Apply change</Button>

      <div className="ask__presets">
        <span><Sparkles size={13} aria-hidden /> Try asking</span>
        {PRESETS.map(p => (
          <button type="button" key={p} onClick={() => setText(p)}>{p}<ArrowRight size={14} aria-hidden /></button>
        ))}
      </div>
      <p className="panel__note">Uses the same AI as Generate. Only your workflow and this instruction are sent, never your data. Check the plain-English steps on the Check tab after each change.</p>
    </div>
  );
}
