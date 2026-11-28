import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
import { NodeIcon } from '../../components/NodeIcon';
import { categoryOf, kindOf, labelOf } from '../../data/nodeKinds';
import { explainStep } from '../../lib/explain';
import { plural } from '../../lib/format';
import type { StepData, StepNode } from './useFlowEditor';

// A finished step shows it on its numbered stop, which fills in; only the states that need a second look get an icon.
const STATE_ICON = {
  waiting: null,
  running: <LoaderCircle size={15} className="spin" />,
  complete: null,
  error: <AlertCircle size={15} />,
};

/** "35 rows" for a step that only reads or passes rows on; "35 rows in, 5 out" for one that changes how many there are. */
const rowsText = (rows: NonNullable<StepData['rows']>) =>
  rows.in === 0 || rows.in === rows.out ? plural(rows.out, 'row') : `${plural(rows.in, 'row')} in, ${rows.out} out`;

export const FlowNode = memo(function FlowNode({ data, selected }: NodeProps<StepNode>) {
  const { step, run, order, rows } = data;
  // Generated steps carry the generic description of their kind; say what this one actually does instead.
  const text = !step.description.trim() || step.description === kindOf(step.type)?.defaultDescription ? explainStep(step) : step.description;
  // The bar is the share of the flow's rows that leave this step, so a row of steps reads as rows thinning out.
  const share = rows ? Math.min(100, Math.max(rows.out ? 4 : 0, (rows.out / rows.most) * 100)) : 0;

  return (
    <div className={`fnode ${selected ? 'is-selected' : ''}`} data-cat={categoryOf(step.type)} data-state={run?.state}>
      {/* The dot a step is joined by on its left carries its number, like the numbered stops along a route. */}
      <Handle type="target" position={Position.Left} className="fnode__stop">{order}</Handle>
      <div className="fnode__head">
        <span className="fnode__icon"><NodeIcon type={step.type} size={16} /></span>
        <span className="fnode__kind">{labelOf(step.type)}</span>
        {run && STATE_ICON[run.state] && <span className="fnode__state">{STATE_ICON[run.state]}</span>}
      </div>
      <div className="fnode__title">{step.name}</div>
      <div className="fnode__desc" title={text}>{text}</div>
      {(run || rows) && (
        <div className="fnode__foot">
          {rows && <span className="fnode__meter" aria-hidden><i style={{ width: `${share}%` }} /></span>}
          {run ? <span className="fnode__run">{run.message}</span> : rows && <span className="fnode__rows" title="Counted on your data in a preview. Nothing is saved.">{rowsText(rows)}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
