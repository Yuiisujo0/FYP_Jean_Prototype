export interface Position {
  x: number;
  y: number;
}

export interface Step {
  id: string;
  type: string;
  name: string;
  description: string;
  config: Record<string, string>;
  position?: Position;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  updatedAt: number;
  nodes: Step[];
  edges: FlowEdge[];
  /** How the workflow was tested by running it after it was generated (the agent's rounds), if it was. */
  checks?: AgentRound[];
  /** The last approval of a reviewed result. It stops counting once the workflow changes (see `workflowHash`). */
  approval?: ApprovalRecord;
}

/** One round of the generate-and-check loop: run the plan, observe, and revise if something looked wrong. */
export interface AgentRound {
  round: number;
  /** What the run showed, as short signal names (e.g. no_rows, skipped_step). Empty means nothing looked wrong. */
  signals: string[];
  /** Exactly what was sent to the AI about the run: counts and column names, never data values. Empty if nothing was sent. */
  sent: string;
  outcome: 'clean' | 'revised' | 'repaired' | 'unchanged' | 'invalid' | 'failed' | 'untestable' | 'limit';
  /** What happened, in plain English. */
  detail: string;
}

/** A reviewed result someone approved: what was checked, what was accepted and why, and fingerprints to detect change. */
export interface ApprovalRecord {
  approvedAt: number;
  approver: string;
  /** SHA-256 of the steps (types and parameters, in order). */
  workflowHash: string;
  /** SHA-256 of the source table as read, or null when the workflow reads no data. */
  inputHash: string | null;
  /** SHA-256 of the result table. */
  outputHash: string;
  source: string | null;
  counts: { total: number; kept: number; excluded: number; flagged: number } | null;
  resultRows: number;
  /** Critical exceptions the approver accepted, with their reasons. */
  resolutions: { exceptionId: string; message: string; note: string }[];
  /** Warnings shown at approval time. */
  warnings: string[];
  /** Assumptions the approver confirmed. */
  assumptions: string[];
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  summary: string;
  detail: string;
  imported?: boolean;
}

export interface DatasetInfo {
  id: number;
  name: string;
  filename: string;
  columns: string[];
  rowCount: number;
  createdAt: number;
  updatedAt: number;
  /** 'result' = a table a workflow saved. Absent or 'upload' = the user's own file (also every dataset saved before this field existed). */
  origin?: 'upload' | 'result';
}

export interface Dataset extends DatasetInfo {
  rows: Record<string, string>[];
}

export type RunState = 'waiting' | 'running' | 'complete' | 'error';

export interface NodeRun {
  state: RunState;
  message: string;
}

export interface RunResult {
  columns: string[];
  rows: Record<string, string>[];
  message: string;
  /** For each result row, the source row numbers it comes from (1 = the first row under the header): one for a plain row, several for a group. */
  lineage: number[][];
  /** What each step did, in order. */
  trace: StepTrace[];
  /** What the run could not handle cleanly. Critical ones must be resolved before the result can be approved. */
  exceptions: RunException[];
  /** Every source row and what happened to it, or null when the workflow reads no data. */
  register: RunRegister | null;
  /** The source table as read (kept in memory for the audit record; never stored or sent anywhere). */
  input?: { name: string; columns: string[]; rows: Record<string, string>[] };
}

export interface StepTrace {
  stepId: string;
  stepName: string;
  type: string;
  rowsIn: number;
  rowsOut: number;
  columnsIn: string[];
  columnsOut: string[];
  message: string;
  /** The step did not do its job (it passed rows through unchanged). */
  skipped: boolean;
}

export type ExceptionKind =
  | 'undecided_rows'     // rows left out because the condition could not be checked on them (blank or not a number)
  | 'kept_undecided'     // rows kept although the condition could not really be checked on them
  | 'skipped_step'       // a step that did not run; rows passed through unchanged
  | 'sort_values'        // blanks or text in a column sorted as numbers
  | 'no_rows'            // the result is empty
  | 'aggregate_skipped'  // cells left out of an average/sum, or rows with a blank group name
  | 'join_unmatched'     // rows with no match in the joined dataset
  | 'join_multiple'      // rows matching several rows in the joined dataset; only the first is used
  | 'duplicate_rows'     // identical rows that all reach the result and are counted again
  | 'replaced_source'    // a later step read another source, so earlier rows were not used
  | 'unbalanced';        // the row register does not add up (a bug guard)

export interface RunException {
  /** Stable for the same workflow and data, e.g. `stepId:undecided:Score:blank`. */
  id: string;
  stepId: string;
  stepName: string;
  kind: ExceptionKind;
  severity: 'critical' | 'warning';
  message: string;
  /** Source row numbers concerned. */
  rows: number[];
  column?: string;
}

export type RowStatus = 'kept' | 'excluded' | 'flagged';

export interface RowRecord {
  /** Row number in the source, 1-based. */
  row: number;
  status: RowStatus;
  /** For excluded and flagged rows: the step that removed the row, and why. */
  stepId?: string;
  reason?: string;
}

export interface RunRegister {
  /** The dataset name or web address the rows came from. */
  source: string;
  total: number;
  kept: number;
  excluded: number;
  flagged: number;
  rows: RowRecord[];
  /** kept + excluded + flagged = total, and the result holds exactly the kept rows. */
  balanced: boolean;
}

export interface ValidationIssue {
  level: 'ERROR' | 'WARNING';
  message: string;
  nodeId?: string;
}

export type AvatarColor = 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'slate';

export interface Profile {
  name: string;
  role: string;
  email: string;
  color: AvatarColor;
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type ModelStatus = 'unknown' | 'checking' | 'online' | 'offline';
