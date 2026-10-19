import { AlertCircle, ArrowRight, Check, History, LoaderCircle, MessageCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { checkByRunning } from '../../lib/agent';
import { browserAgentDeps } from '../../lib/agentDeps';
import { generateFlow } from '../../lib/api';
import { chainEdges, defaultPosition, orderSteps } from '../../lib/flowGraph';
import { addHistory, clearHistory, loadHistory, type HistoryItem } from '../../lib/history';
import { datasetBriefs } from '../../lib/library';
import { PROVIDER_LABEL } from '../../lib/providerConfig';
import { smallTalk, type SmallTalk } from '../../lib/smalltalk';
import type { AgentRound, Flow } from '../../types';
import { useWorkspace } from '../../state/WorkspaceContext';
import './GeneratePage.css';

const MAX_LENGTH = 500;

const EXAMPLES = [
  'Read a CSV of student marks and flag everyone below 50, then save them to the database',
  'Summarise a document with the local model and prepare a short report',
  'Fetch records from an API, clean the fields, and export the result',
];

export function GeneratePage() {
  const { flows, addFlow, notify, ollama } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const initial = (location.state as { prompt?: string } | null)?.prompt ?? '';

  const [prompt, setPrompt] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  // 'generate': the model drafts the workflow; 'test': the agent runs it on your data and revises it if needed.
  const [stage, setStage] = useState<'generate' | 'test'>('generate');
  const [rounds, setRounds] = useState<AgentRound[]>([]);
  const abort = useRef<AbortController | null>(null);
  // A greeting or "what can you do" is answered here, without calling the AI.
  const [chat, setChat] = useState<{ user: string; talk: SmallTalk } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!busy) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const run = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    const talk = smallTalk(text);
    if (talk) {
      setChat({ user: text, talk });
      setError('');
      setPrompt('');
      return;
    }
    setChat(null);
    setError('');
    setBusy(true);
    setStage('generate');
    setRounds([]);
    const controller = new AbortController();
    abort.current = controller;
    const started = Date.now();
    try {
      const datasets = await datasetBriefs();
      const result = await generateFlow(text, controller.signal, datasets);
      let flow: Flow = result.flow;
      let status = '';
      if (result.valid) {
        // The agent: run the plan on the user's data (a dry run), look at what happened, revise if something looks wrong.
        setStage('test');
        const checked = await checkByRunning(orderSteps(flow.nodes, flow.edges), {
          ...browserAgentDeps(text, datasets, controller.signal),
          onRound: round => setRounds(rs => [...rs, round]),
        });
        const nodes = checked.steps.map((s, i) => ({ ...s, position: defaultPosition(i) }));
        flow = { ...flow, nodes, edges: chainEdges(nodes), checks: checked.rounds };
        status = checked.status === 'clean' ? ' and tested on your data' : checked.status === 'open' ? '; testing found something to review' : '';
      }
      if (controller.signal.aborted) return;
      addFlow(flow);
      setHistory(addHistory(text, flow.id));
      notify(result.valid ? `Workflow generated${status} in ${((Date.now() - started) / 1000).toFixed(1)} s` : 'Workflow generated with issues to review');
      navigate(`/editor/${flow.id}`, { state: { fresh: true } });
    } catch (e) {
      if (controller.signal.aborted) return;
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Generation failed.');
    }
  };

  return (
    <div className="page gen">
      <header className="gen__head">
        <h1>What should the workflow do?</h1>
        <p>Describe the outcome in plain language. jwork picks from its supported operations, arranges them in order and checks the result.</p>
      </header>

      <div className="gen__card card">
        <label htmlFor="prompt" className="sr-only">Describe your automation</label>
        <textarea
          id="prompt"
          className="gen__input"
          autoFocus
          value={prompt}
          maxLength={MAX_LENGTH}
          disabled={busy}
          placeholder="Read a CSV of student scores, find everyone below 50, and prepare a review list…"
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && run()}
        />
        <div className="gen__bar">
          <span className="gen__count">{prompt.length}/{MAX_LENGTH} · <kbd>Ctrl</kbd> <kbd>Enter</kbd> to build</span>
          <Button variant="primary" size="lg" disabled={!prompt.trim()} loading={busy} icon={<Sparkles size={17} />} onClick={run}>
            {busy ? 'Building…' : 'Build workflow'}
          </Button>
        </div>
      </div>

      <p className="gen__model">
        Using <b>{ollama.modelName}</b> · {PROVIDER_LABEL[ollama.provider.kind]}. <Link to="/settings?tab=model">Change model</Link>
      </p>

      {chat && !busy && (
        <div className="gen__chat" aria-live="polite">
          <p className="gen__you">{chat.user}</p>
          <div className="gen__reply">
            <MessageCircle size={17} aria-hidden />
            <div>
              <p>{chat.talk.reply}</p>
              {chat.talk.suggestions.length > 0 && (
                <div className="gen__list">
                  {chat.talk.suggestions.map(text => (
                    <button type="button" key={text} onClick={() => { setPrompt(text); setChat(null); }}>
                      <span>{text}</span>
                      <ArrowRight size={16} aria-hidden />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="gen__error" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span><b>Could not build this workflow</b>{error}</span>
          <Button size="sm" onClick={run}>Try again</Button>
        </div>
      )}

      {busy && (
        <ol className="gen__stages card" aria-live="polite">
          <li className={stage === 'generate' ? 'is-active' : 'is-done'}>
            <span className="gen__marker">{stage === 'generate' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}</span>
            <span>
              <b>Generating and validating{stage === 'generate' ? ` · ${seconds}s` : ''}</b>
              {stage === 'generate' && seconds >= 8 && <span className="gen__found">The first request also loads the model, so it can take longer.</span>}
            </span>
          </li>
          {stage === 'test' && (
            <li className="is-active">
              <span className="gen__marker"><LoaderCircle size={14} className="spin" /></span>
              <span>
                <b>Testing it on your data · {seconds}s</b>
                <span className="gen__found">A dry run in your browser: nothing is saved, and the AI sees only counts and column names.</span>
                {rounds.map(r => <span key={r.round} className="gen__found">Round {r.round}: {r.detail}</span>)}
              </span>
            </li>
          )}
        </ol>
      )}

      {!busy && history.length > 0 && (
        <section className="gen__examples gen__history">
          <div className="gen__history-head">
            <h2><History size={14} aria-hidden /> Your recent requests</h2>
            <button type="button" className="gen__clear" onClick={() => setHistory(clearHistory())}>Clear</button>
          </div>
          <div className="gen__list">
            {history.map(h => (
              <div key={h.id} className="gen__hrow">
                <button type="button" onClick={() => { setPrompt(h.text); setChat(null); }} title="Use this request again">
                  <span>{h.text}</span>
                  <small>{new Date(h.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>
                </button>
                {flows.some(f => f.id === h.flowId) && <Link to={`/editor/${h.flowId}`} className="gen__open">Open workflow</Link>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!busy && (
        <section className="gen__examples">
          <h2>Or start from an example</h2>
          <div className="gen__list">
            {EXAMPLES.map(text => (
              <button type="button" key={text} onClick={() => setPrompt(text)}>
                <span>{text}</span>
                <ArrowRight size={16} aria-hidden />
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="gen__foot">
        <ShieldCheck size={16} aria-hidden />
        Drafted by an AI model, then checked against the supported operations and tested on your data in this browser.
      </p>
    </div>
  );
}
