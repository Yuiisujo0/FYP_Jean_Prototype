import { MousePointerClick, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { NodeIcon } from '../../components/NodeIcon';
import { IconButton } from '../../components/ui/Button';
import { categoryOf, kindOf, labelOf } from '../../data/nodeKinds';
import { useDatasets } from '../../state/useDatasets';
import type { Step } from '../../types';

interface Props {
  step: Step | null;
  onPatch: (id: string, patch: Partial<Step>) => void;
  onDelete: (id: string) => void;
}

export function Inspector({ step, onPatch, onDelete }: Props) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const { items: datasets } = useDatasets(step?.type === 'READ_CSV' || step?.type === 'DATABASE');
  const uploads = datasets?.filter(d => d.origin !== 'result') ?? [];
  const results = datasets?.filter(d => d.origin === 'result') ?? [];

  if (!step) {
    return (
      <div className="panel panel--center">
        <MousePointerClick size={26} aria-hidden />
        <h3 className="panel__title">Nothing selected</h3>
        <p className="panel__lead">Select a step on the canvas to edit its name, description and parameters.</p>
      </div>
    );
  }

  const required = new Set(kindOf(step.type)?.required ?? []);
  const isMode = (key: string) => step.type === 'DATABASE' && key === 'mode';
  // A Database step's mode is always offered, even when the workflow does not set it (the default is replace).
  const params: [string, string][] = Object.entries(step.config);
  if (step.type === 'DATABASE' && !('mode' in step.config)) params.push(['mode', 'replace']);
  const setConfig = (key: string, value: string) => onPatch(step.id, { config: { ...step.config, [key]: value } });
  const removeConfig = (key: string) => {
    const { [key]: _removed, ...rest } = step.config;
    onPatch(step.id, { config: rest });
  };
  const addParameter = () => {
    const key = newKey.trim().replace(/\s+/g, '_').toLowerCase();
    if (key && !(key in step.config)) setConfig(key, '');
    setNewKey('');
    setAdding(false);
  };

  return (
    <div className="panel" key={step.id}>
      <div className="insp__title" data-cat={categoryOf(step.type)}>
        <span className="insp__icon"><NodeIcon type={step.type} size={18} /></span>
        <span>
          <b>{labelOf(step.type)}</b>
          <small>{step.type}</small>
        </span>
        <IconButton label="Delete step" danger onClick={() => onDelete(step.id)}><Trash2 size={17} /></IconButton>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="insp-name">Name</label>
        <input id="insp-name" className="input" value={step.name} onChange={e => onPatch(step.id, { name: e.target.value })} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="insp-desc">Description</label>
        <textarea id="insp-desc" className="textarea" rows={3} value={step.description} onChange={e => onPatch(step.id, { description: e.target.value })} />
      </div>

      <div className="insp__params">
        <h4>Parameters</h4>
        {params.map(([key, value]) => (
          <div className="field" key={key}>
            <label className="field__label insp__key" htmlFor={`cfg-${key}`}>
              {key.replaceAll('_', ' ')}
              {required.has(key) ? <em>required</em> : isMode(key) ? null : (
                <button type="button" className="insp__remove" onClick={() => removeConfig(key)} aria-label={`Remove ${key}`}><X size={13} /></button>
              )}
            </label>
            {step.type === 'READ_CSV' && key === 'file' && datasets ? (
              <>
                <select id={`cfg-${key}`} className="input" value={datasets.some(d => d.name === value) ? value : ''} onChange={e => setConfig(key, e.target.value)}>
                  <option value="" disabled>{datasets.length ? 'Choose a dataset…' : 'No datasets yet'}</option>
                  {uploads.length > 0 && <optgroup label="Your data">{uploads.map(d => <option key={d.id} value={d.name}>{d.name} ({d.rowCount} rows)</option>)}</optgroup>}
                  {results.length > 0 && <optgroup label="Saved by workflows">{results.map(d => <option key={d.id} value={d.name}>{d.name} ({d.rowCount} rows)</option>)}</optgroup>}
                </select>
                {!datasets.some(d => d.name === value) && value && (
                  <small className="insp__hint">“{value}” is not in the Data library. Choose a dataset, or <Link to="/knowledge?tab=data">upload one</Link>.</small>
                )}
              </>
            ) : isMode(key) ? (
              <>
                <select id={`cfg-${key}`} className="input" value={value.trim().toLowerCase() === 'append' ? 'append' : 'replace'} onChange={e => setConfig(key, e.target.value)}>
                  <option value="replace">Replace the table each run</option>
                  <option value="append">Add the rows to the table each run</option>
                </select>
                <small className="insp__hint">
                  {value.trim().toLowerCase() === 'append'
                    ? 'The table is created the first time. After that its columns must match this result. Running again adds the rows again.'
                    : 'Whatever the table held before is replaced. A table you uploaded yourself is never replaced.'}
                </small>
              </>
            ) : (
              <>
                <input id={`cfg-${key}`} className="input mono" value={value} list={step.type === 'DATABASE' && key === 'table' ? 'insp-tables' : undefined} onChange={e => setConfig(key, e.target.value)} />
                {step.type === 'DATABASE' && key === 'table' && <datalist id="insp-tables">{results.map(d => <option key={d.id} value={d.name} />)}</datalist>}
              </>
            )}
          </div>
        ))}
        {adding ? (
          <div className="insp__add">
            <input
              className="input"
              autoFocus
              value={newKey}
              placeholder="parameter name"
              onChange={e => setNewKey(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addParameter(); if (e.key === 'Escape') setAdding(false); }}
              onBlur={addParameter}
            />
          </div>
        ) : (
          <button type="button" className="insp__add-btn" onClick={() => setAdding(true)}><Plus size={15} /> Add parameter</button>
        )}
      </div>
    </div>
  );
}
