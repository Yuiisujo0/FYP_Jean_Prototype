import { ArrowDownToLine, ArrowUpRight, Clock3, Copy, LayoutGrid, List, Plus, Search, Sparkles, Trash2, Upload, Workflow as WorkflowIcon, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlowPreview } from '../../components/FlowPreview';
import { Badge } from '../../components/ui/Badge';
import { Button, IconButton } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Menu } from '../../components/ui/Menu';
import { PageHeader } from '../../components/ui/PageHeader';
import { Segmented } from '../../components/ui/Segmented';
import { plural, timeAgo } from '../../lib/format';
import { errorCount, validateWorkflow, warningCount } from '../../lib/validate';
import { useDialogs } from '../../state/DialogsContext';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Flow } from '../../types';
import './WorkflowsPage.css';

type View = 'list' | 'grid';
type Sort = 'recent' | 'name';

function StatusBadge({ flow }: { flow: Flow }) {
  const issues = validateWorkflow(flow.nodes, flow.edges);
  const errors = errorCount(issues);
  if (errors) return <Badge tone="danger" dot>{plural(errors, 'error')}</Badge>;
  const warnings = warningCount(issues);
  if (warnings) return <Badge tone="warn" dot>{plural(warnings, 'warning')}</Badge>;
  return <Badge tone="ok" dot>Valid</Badge>;
}

export function WorkflowsPage() {
  const { flows, deleteFlow, duplicateFlow, exportFlow } = useWorkspace();
  const { openCreate, openImport } = useDialogs();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('list');
  const [sort, setSort] = useState<Sort>('recent');

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = flows.filter(f => !q || `${f.name} ${f.description}`.toLowerCase().includes(q));
    return [...matches].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt));
  }, [flows, search, sort]);

  const menuFor = (f: Flow) => (
    <Menu
      label={`Actions for ${f.name}`}
      items={[
        { label: 'Open', icon: <ArrowUpRight size={16} />, onSelect: () => navigate(`/editor/${f.id}`) },
        { label: 'Duplicate', icon: <Copy size={16} />, onSelect: () => duplicateFlow(f) },
        { label: 'Export JSON', icon: <ArrowDownToLine size={16} />, onSelect: () => exportFlow(f) },
        { label: 'Delete', icon: <Trash2 size={16} />, danger: true, separatorBefore: true, onSelect: () => deleteFlow(f.id) },
      ]}
    />
  );

  return (
    <div className="page">
      <PageHeader
        title="Workflows"
        description="Every workflow you have generated or built, saved in this browser."
        actions={<>
          <Button icon={<Upload size={16} />} onClick={openImport}>Import</Button>
          <Button icon={<Sparkles size={16} />} onClick={() => navigate('/generate')}>Generate</Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>New workflow</Button>
        </>}
      />

      <div className="toolbar">
        <label className="search toolbar__search">
          <Search size={16} aria-hidden />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search workflows…" aria-label="Search workflows" />
          {search && <IconButton label="Clear search" onClick={() => setSearch('')} className="toolbar__clear"><X size={15} /></IconButton>}
        </label>
        <select className="select toolbar__sort" value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort workflows">
          <option value="recent">Recently updated</option>
          <option value="name">Name</option>
        </select>
        <Segmented<View>
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: 'List', icon: <List size={15} /> },
            { value: 'grid', label: 'Grid', icon: <LayoutGrid size={15} /> },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={search ? <Search size={24} /> : <WorkflowIcon size={24} />}
            title={search ? 'No workflows found' : 'No workflows yet'}
            description={search ? 'Try a different search term.' : 'Describe a task and let jwork draft the flow, or start from scratch.'}
            action={!search && <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>New workflow</Button>}
          />
        </div>
      ) : view === 'list' ? (
        <ul className="wf-list card">
          <li className="wf-row wf-row--head" aria-hidden>
            <span>Name</span><span>Shape</span><span>Updated</span><span>Status</span><span />
          </li>
          {visible.map(f => (
            <li className="wf-row" key={f.id}>
              <Link to={`/editor/${f.id}`} className="wf-row__name">
                <b>{f.name}</b>
                <small>{f.description}</small>
              </Link>
              <FlowPreview flow={f} max={4} />
              <span className="wf-row__time"><Clock3 size={14} aria-hidden /> {timeAgo(f.updatedAt)}</span>
              <StatusBadge flow={f} />
              {menuFor(f)}
            </li>
          ))}
        </ul>
      ) : (
        <div className="wf-grid">
          {visible.map(f => (
            <article className="wf-card card" key={f.id}>
              <div className="wf-card__top">
                <StatusBadge flow={f} />
                {menuFor(f)}
              </div>
              <Link to={`/editor/${f.id}`} className="wf-card__body">
                <FlowPreview flow={f} />
                <h3>{f.name}</h3>
                <p>{f.description}</p>
              </Link>
              <div className="wf-card__meta">
                <span>{plural(f.nodes.length, 'step')}</span>
                <span><Clock3 size={13} aria-hidden /> {timeAgo(f.updatedAt)}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="hint">{plural(flows.length, 'workflow')} stored locally in this browser. Export a workflow to back it up.</p>
    </div>
  );
}
