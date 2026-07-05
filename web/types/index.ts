/**
 * types/index.ts — Week 3 Updated
 *
 * Apply to BOTH:
 *   server/src/types/index.ts
 *   web/types/index.ts
 *
 * Changes from Week 3:
 *   + browser_screenshot_analyze  (NEW — Vision fallback capability)
 *
 * Already present from Week 2:
 *   + browser_wait_for_element
 *   + browser_get_page_state
 */

// ─── Capability Union ─────────────────────────────────────────────────────────
// This is the exhaustive list of all capabilities the planner can emit.
// Add new capabilities here AND in:
//   1. stepExecutor.ts executeStep() switch
//   2. planner.ts VALID_CAPABILITIES set
//   3. planner.ts STATIC_SYSTEM_PROMPT capability catalog

export type Capability =
  // Browser automation
  | 'browser_open'
  | 'browser_click'
  | 'browser_fill'
  | 'browser_read_page'
  | 'browser_extract_results'
  | 'browser_wait_for_element'      // Week 2: waits for selector to appear
  | 'browser_get_page_state'        // Week 3: checks for bot/404/error pages
  | 'browser_screenshot_analyze'    // Week 3: Gemini vision fallback for hard UIs

  // App automation
  | 'open_application'
  | 'app_find_window'
  | 'app_focus_window'
  | 'app_click'
  | 'app_type'
  | 'app_screenshot'
  | 'app_verify'

  // System
  | 'type_text'
  | 'run_shell_command'
  | 'set_wallpaper'

  // Files
  | 'create_file'
  | 'create_folder'
  | 'download_file'

  // Utility
  | 'wait';


// ─── Step Parameters ──────────────────────────────────────────────────────────

export interface StepParameters {
  // browser_open
  url?: string;

  // browser_click / browser_fill / browser_wait_for_element
  selector?: string;
  value?: string;
  seconds?: number;

  // browser_read_page / browser_extract_results
  variable_name?: string;
  topic?: string;
  count?: number;

  // browser_screenshot_analyze  (Week 3)
  target_description?: string;
  action?: 'click' | 'fill';

  // open_application / app_*
  app_name?: string;
  element_name?: string;
  text?: string;

  // create_file / create_folder / download_file
  path?: string;
  destination?: string;
  content?: string;

  // run_shell_command
  command?: string;

  // set_wallpaper
  query?: string;
}


// ─── Plan Step ────────────────────────────────────────────────────────────────

export interface PlanStep {
  step_number: number;
  capability: Capability;
  parameters: StepParameters;
  description: string;
  safety_risk?: 'low' | 'medium' | 'high';
}


// ─── Plan ─────────────────────────────────────────────────────────────────────

export interface Plan {
  steps: PlanStep[];
  reasoning?: string;
  intent?: string;
  summary?: string;
  confidence?: number;
  requires_confirmation?: boolean;
}


// ─── Step Result ──────────────────────────────────────────────────────────────

export interface StepResult {
  success: boolean;
  message?: string;
  url?: string;
  title?: string;
  content?: string;
  results?: unknown[];
  navigated?: boolean;
  warning?: string;
  strategy?: string;       // Which tier/selector won (for logging)
  error?: string;
  path?: string;
  [key: string]: unknown;
}

export interface StepExecutionResult {
  stepNumber: number;
  success: boolean;
  result?: StepResult;
  error?: string;
  duration?: number;
}

export interface ReviewResult {
  verdict: 'SAFE' | 'UNSAFE' | 'REVIEW_REQUIRED';
  confidence: number;
  risks: string[];
  safe_steps: number[];
  risky_steps: number[];
  recommendation: string;
}

export interface ExecutionSummary {
  total: number;
  success: number;
  failed: number;
  duration: number;
}

export type StepStatus = 'pending' | 'running' | 'complete' | 'error'

export interface ExecutionState {
  status: 'idle' | 'executing' | 'completed' | 'failed' | 'stopped'
  currentStep: number | null
  completedSteps: number[]
  failedStep: number | null
  stepResults: Record<number, StepResult>
  summary: ExecutionSummary | null
}

export interface ActivityEvent {
  type: WsMessageType
  message: string
  time: string
}

export type WsMessageType =
  | 'connected'
  | 'planning'
  | 'plan_ready'
  | 'execution_start'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'safety_check'
  | 'execution_complete'
  | 'execution_failed'
  | 'execution_stopped'
  | 'error'

export interface WsMessage {
  type: WsMessageType
  message?: string
  sessionId?: string
  plan?: Plan
  totalSteps?: number
  stepNumber?: number
  step?: PlanStep
  result?: StepResult
  duration?: number
  error?: string
  results?: Array<{
    stepNumber: number
    success: boolean
    result?: StepResult
    error?: string
    duration?: number
  }>
  summary?: ExecutionSummary
}


// ─── Execution Log Entry ──────────────────────────────────────────────────────

export interface ExecutionLogEntry {
  sessionId:     string;
  taskPrompt:    string;
  timestamp:     string;
  totalSteps:    number;
  failedSteps:   number;
  overallSuccess: boolean;
  successRate:   number;
  durationMs:    number;
  steps: Array<{
    stepIndex:    number;
    capability:   Capability;
    description:  string;
    success:      boolean;
    strategy?:    string;
    errorMessage?: string;
    durationMs:   number;
    retryCount:   number;
    pageUrl?:     string;
  }>;
}