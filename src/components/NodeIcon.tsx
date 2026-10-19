import { ArrowUpRight, Cloud, Database, FileInput, FileText, Filter, Shapes, Sheet, Sparkles, type LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  INPUT: FileInput,
  READ_FILE: FileText,
  READ_CSV: Sheet,
  LLM: Sparkles,
  FILTER: Filter,
  TRANSFORM: Shapes,
  DATABASE: Database,
  HTTP_REQUEST: Cloud,
  OUTPUT: ArrowUpRight,
};

export function NodeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = ICONS[type] ?? Shapes;
  return <Icon size={size} aria-hidden />;
}
