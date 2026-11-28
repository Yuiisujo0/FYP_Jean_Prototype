import { Plus } from 'lucide-react';
import { NodeIcon } from '../../components/NodeIcon';
import { kindOf } from '../../data/nodeKinds';

export const DRAG_TYPE = 'application/x-jwork-node';

/** The nine operations in the order a flow uses them, so the list is three short groups and not one long one. */
const GROUPS: { title: string; types: string[] }[] = [
  { title: 'Bring data in', types: ['READ_CSV', 'READ_FILE', 'INPUT', 'HTTP_REQUEST'] },
  { title: 'Work on it', types: ['FILTER', 'TRANSFORM', 'LLM'] },
  { title: 'Send it out', types: ['OUTPUT', 'DATABASE'] },
];

export function NodeLibrary({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className="panel">
      <h3 className="panel__title">Operations</h3>
      <p className="panel__lead">Click one to add it at the end, or drag it onto the canvas.</p>
      {GROUPS.map(group => (
        <section className="lib" key={group.title} aria-label={group.title}>
          <h4 className="lib__group">{group.title}</h4>
          {group.types.map(type => kindOf(type)!).map(k => (
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
              <span className="lib__icon"><NodeIcon type={k.type} size={16} /></span>
              <span className="lib__text">
                <b>{k.label}</b>
                <small>{k.blurb}</small>
              </span>
              <Plus size={16} className="lib__plus" aria-hidden />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
