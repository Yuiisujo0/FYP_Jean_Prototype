import { categoryOf } from '../data/nodeKinds';
import { orderSteps } from '../lib/flowGraph';
import type { Flow } from '../types';
import { NodeIcon } from './NodeIcon';
import './FlowPreview.css';

/** A compact chain of coloured node icons that shows a workflow's shape at a glance. */
export function FlowPreview({ flow, max = 5 }: { flow: Flow; max?: number }) {
  const steps = orderSteps(flow.nodes, flow.edges);
  const shown = steps.slice(0, max);
  const hidden = steps.length - shown.length;
  return (
    <div className="flow-preview" aria-hidden>
      {shown.map((s, i) => (
        <span className="flow-preview__item" key={s.id}>
          {i > 0 && <i className="flow-preview__link" />}
          <span className="flow-preview__node" data-cat={categoryOf(s.type)}><NodeIcon type={s.type} size={13} /></span>
        </span>
      ))}
      {hidden > 0 && <span className="flow-preview__more">+{hidden}</span>}
    </div>
  );
}
