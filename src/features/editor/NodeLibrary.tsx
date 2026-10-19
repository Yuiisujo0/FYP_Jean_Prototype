import { GripVertical, Plus } from 'lucide-react';
import { NodeIcon } from '../../components/NodeIcon';
import { NODE_KINDS } from '../../data/nodeKinds';

export const DRAG_TYPE = 'application/x-jwork-node';

export function NodeLibrary({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className="panel">
      <h3 className="panel__title">Operations</h3>
      <p className="panel__lead">Click to add a step after the current one, or drag onto the canvas.</p>
      <div className="lib">
        {NODE_KINDS.map(k => (
          <button
            key={k.type}
            type="button"
            className="lib__item"
            data-cat={k.category}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData(DRAG_TYPE, k.type);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onAdd(k.type)}
          >
            <GripVertical size={14} className="lib__grip" aria-hidden />
            <span className="lib__icon"><NodeIcon type={k.type} size={16} /></span>
            <span className="lib__text">
              <b>{k.label}</b>
              <small>{k.blurb}</small>
            </span>
            <Plus size={16} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
