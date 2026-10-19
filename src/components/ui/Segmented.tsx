import { useRef, type ReactNode } from 'react';
import { useSlider } from './useSlider';

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const slider = useSlider(ref, 'button[aria-pressed="true"]', [value]);
  return (
    <div className="segmented" role="group" aria-label={label} ref={ref}>
      <span className={`segmented__pill ${slider.ready ? 'is-ready' : ''}`} style={slider.style} aria-hidden />
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
