import { BookOpen, ChevronRight, Database, Library, Search, Sparkles, Upload, Workflow } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { Segmented } from '../../components/ui/Segmented';
import { LIBRARY_PATTERNS } from '../../data/patterns';
import { labelOf } from '../../data/nodeKinds';
import { explainStep } from '../../lib/explain';
import { plural } from '../../lib/format';
import { useWorkspace } from '../../state/WorkspaceContext';
import { DataLibrary } from './DataLibrary';
import './KnowledgePage.css';

type Tab = 'patterns' | 'data';

/** What the list shows: a workflow pattern (shown to the AI as an example) or a reading note (never sent to the AI). */
interface Item {
  id: string;
  group: (typeof GROUPS)[number];
  title: string;
  summary: string;
  badge: string;
  note?: { category: string; detail: string; imported: boolean };
  pattern?: (typeof LIBRARY_PATTERNS)[number];
}

const GROUPS = ['Workflow patterns', 'Notes'] as const;

export function KnowledgePage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'data' ? 'data' : 'patterns');
  const dataUploadRef = useRef<HTMLInputElement>(null);
  const { knowledge, importKnowledge } = useWorkspace();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = useMemo<Item[]>(() => [
    ...LIBRARY_PATTERNS.map<Item>(p => ({ id: `pattern:${p.id}`, group: 'Workflow patterns', title: p.title, summary: p.request, badge: p.steps.map(s => labelOf(s.type)).join(' → '), pattern: p })),
    ...knowledge.map<Item>(k => ({ id: `note:${k.id}`, group: 'Notes', title: k.title, summary: k.summary, badge: k.category + (k.imported ? ' · Imported' : ''), note: { category: k.category, detail: k.detail, imported: !!k.imported } })),
  ], [knowledge]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(k => (!category || k.group === category) && (!q || `${k.title} ${k.badge} ${k.summary}`.toLowerCase().includes(q)));
  }, [items, query, category]);

  const selected = visible.find(k => k.id === selectedId) ?? visible[0];

  return (
    <div className="page">
      <PageHeader
        title="Knowledge base"
        description={tab === 'patterns'
          ? 'Example workflows written for this project. When you describe a task, the two closest are shown to the AI as examples. Notes and imported entries are for reading only and are not sent to the AI.'
          : 'Your data, kept separate from workflows. Upload a file once and let workflows read it, then replace it when it changes.'}
        actions={tab === 'patterns'
          ? <Button icon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>Import entries</Button>
          : <Button variant="primary" icon={<Upload size={16} />} onClick={() => dataUploadRef.current?.click()}>Upload files</Button>}
      />
      <div className="kb-tabs">
        <Segmented<Tab>
          label="Knowledge sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'patterns', label: 'Patterns', icon: <BookOpen size={15} /> },
            { value: 'data', label: 'Data', icon: <Database size={15} /> },
          ]}
        />
      </div>
      {tab === 'data' ? <DataLibrary uploadRef={dataUploadRef} /> : <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void importKnowledge(file);
          e.currentTarget.value = '';
        }}
      />

      <div className="kb-tools">
        <label className="search kb-tools__search">
          <Search size={16} aria-hidden />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search patterns…" aria-label="Search knowledge" />
        </label>
        <div className="kb-chips" role="group" aria-label="Filter by category">
          <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)}>All</button>
          {GROUPS.map(c => (
            <button type="button" key={c} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>{c}</button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Library size={24} />}
            title="Nothing matches"
            description="Try another search, or import a JSON file of notes."
          />
        </div>
      ) : (
        <div className="kb">
          <ul className="kb__list card">
            {visible.map(k => (
              <li key={k.id}>
                <button type="button" className="kb__row" aria-current={selected?.id === k.id} onClick={() => setSelectedId(k.id)}>
                  <span className="kb__icon">{k.pattern ? <Workflow size={17} /> : <BookOpen size={17} />}</span>
                  <span className="kb__text">
                    <small>{k.badge}</small>
                    <b>{k.title}</b>
                    <span>{k.summary}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <article className="kb__detail card" key={selected.id}>
              {selected.pattern ? (
                <>
                  <div className="kb__tags">
                    <Badge tone="accent">Workflow pattern</Badge>
                    <Badge tone="ok">Shown to the AI</Badge>
                    <Badge tone={selected.pattern.verified ? 'neutral' : 'warn'}>{selected.pattern.verified ? 'Checked on sample data' : 'Example only'}</Badge>
                  </div>
                  <h2>{selected.title}</h2>
                  <p className="kb__summary">A user might type: “{selected.pattern.request}”</p>
                  <h3>Steps</h3>
                  <ol className="kb__steps">
                    {selected.pattern.steps.map(s => (
                      <li key={s.id}><b>{labelOf(s.type)}</b><span>{explainStep(s)}</span></li>
                    ))}
                  </ol>
                  <p className="hint">
                    {selected.pattern.verified
                      ? 'Its result was compared with an answer worked out separately, so this is a correct way to do the task.'
                      : 'This one uses the web or the AI model, which cannot be checked without a network, so it is an example only.'}
                  </p>
                  <Button size="sm" variant="primary" icon={<Sparkles size={15} />} onClick={() => navigate('/generate', { state: { prompt: selected.pattern!.request } })}>Try this request</Button>
                </>
              ) : selected.note && (
                <>
                  <div className="kb__tags">
                    <Badge tone="accent">{selected.note.category}</Badge>
                    <Badge tone={selected.note.imported ? 'warn' : 'neutral'}>{selected.note.imported ? 'Imported' : 'Built in'}</Badge>
                    <Badge>Reading only</Badge>
                  </div>
                  <h2>{selected.title}</h2>
                  <p className="kb__summary">{selected.summary}</p>
                  <h3>Guidance</h3>
                  <p>{selected.note.detail}</p>
                  <p className="hint">This note is for you. It is not sent to the AI.</p>
                </>
              )}
            </article>
          )}
        </div>
      )}

      <p className="hint">{plural(LIBRARY_PATTERNS.length, 'workflow pattern')} shown to the AI as examples, and {plural(knowledge.length, 'note')} for reading. Imported notes stay in this browser.</p>
      </>}
    </div>
  );
}
