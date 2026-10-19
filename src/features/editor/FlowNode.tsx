import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
import { NodeIcon } from '../../components/NodeIcon';
import { categoryOf, kindOf, labelOf } from '../../data/nodeKinds';
import { explainStep } from '../../lib/explain';
import type { StepNode } from './useFlowEditor';

const STATE_ICON = {
  waiting: <Clock3 size={15} />,
  running: <LoaderCircle size={15} className="spin" />,
  complete: <CheckCircle2 size={15} />,
  error: <AlertCircle size={15} />,
};

export const FlowNode = memo(function FlowNode({ data, selected }: NodeProps<StepNode>) {
  const { step, run } = data;
  const params = Object.values(step.config).filter(Boolean).slice(0, 2);
  // Generated steps carry the generic description of their kind; say what this one actually does instead.
  const text = !step.description.trim() || step.description === kindOf(step.type)?.defaultDescription ? explainStep(step) : step.description;

  return (
    <div className={`fnode ${selected ? 'is-selected' : ''}`} data-cat={categoryOf(step.type)} data-state={run?.state}>
      <Handle type="target" position={Position.Left} />
      <div className="fnode__head">
        <span className="fnode__icon"><NodeIcon type={step.type} size={15} /></span>
        <span className="fnode__kind">{labelOf(step.type)}</span>
        {run && <span className="fnode__state">{STATE_ICON[run.state]}</span>}
      </div>
      <div className="fnode__title">{step.name}</div>
      <div className="fnode__desc" title={text}>{text}</div>
      <div className="fnode__foot">
        {run ? <span className="fnode__run">{run.message}</span> : params.map(p => <code key={p}>{p}</code>)}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
