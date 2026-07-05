'use client'
import { useState } from 'react'
import {
  Plan, PlanStep, ReviewResult, ExecutionState,
  Capability, StepStatus, StepResult, ExecutionSummary,
} from '@/types'

// ── Icons ─────────────────────────────────────────────────────────────────────
const CAP_ICON: Partial<Record<Capability, string>> = {
  open_application: '📱', set_wallpaper: '🖼️', run_shell_command: '💻',
  browser_open: '🌐', browser_fill: '✏️', browser_click: '👆',
  browser_read_page: '📖', browser_extract_results: '⚡',
  browser_wait_for_element: '⏳', browser_get_page_state: '🔍',
  browser_screenshot_analyze: '📸',
  type_text: '⌨️', create_file: '📄', create_folder: '📁',
  wait: '⏳', download_file: '⬇️',
}

// Accent color per capability — returned as Tailwind-compatible hex for inline use only on SVG/border
const CAP_COLOR: Partial<Record<string, string>> = {
  browser_open: '#00e5ff', browser_extract_results: '#a855f7',
  browser_read_page: '#00ffa3', browser_click: '#00e5ff',
  browser_fill: '#ffb340', browser_wait_for_element: '#a855f7',
  browser_get_page_state: '#00e5ff', browser_screenshot_analyze: '#a855f7',
  create_file: '#ffb340', create_folder: '#ffb340',
  run_shell_command: '#ff3d5a', open_application: '#a855f7',
  download_file: '#00e5ff', type_text: '#ddddf0', wait: '#252540',
}
const capColor = (cap: string) => CAP_COLOR[cap] ?? '#00e5ff'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  plan: Plan | null
  executionState: ExecutionState
  onConfirm: () => void
  onStop: () => void
  reviewing: boolean
  review: ReviewResult | null
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function PlanDisplay({ plan, executionState, onConfirm, onStop, reviewing, review }: Props) {
  const [showJson, setShowJson] = useState(false)

  if (!plan) return null

  const { steps } = plan
  const isExec  = executionState.status === 'executing'
  const isDone  = executionState.status === 'completed'
  const isFail  = executionState.status === 'failed'
  const done    = executionState.completedSteps.length
  const total   = steps.length
  const pct     = isDone ? 100 : isExec && total ? Math.round((done / total) * 100) : 0

  const getStatus = (n: number): StepStatus => {
    if (executionState.currentStep === n && isExec) return 'running'
    if (executionState.completedSteps.includes(n))  return 'complete'
    if (executionState.failedStep === n)             return 'error'
    return 'pending'
  }

  return (
    <div className="flex flex-col gap-4 slide-up-anim">

      {/* Plan header */}
      <div className="bg-s2 border border-border rounded-lg p-4">
        <div className="flex-1">
          {plan.intent && (
            <div className="mb-2">
              <span className="text-xs text-muted font-500">Intent</span>
              <div className="text-xs text-cyan bg-cyan/10 border border-cyan/20 px-2 py-1 rounded mt-1 inline-block">
                {plan.intent}
              </div>
            </div>
          )}
          <p className="text-sm text-ntext leading-relaxed mb-3">
            {plan.summary ?? plan.reasoning}
          </p>
          <div className="flex items-center gap-6 text-xs text-muted">
            <span><span className="text-ntext font-500">{total}</span> steps</span>
            <span><span className="text-green font-500">{steps.filter((s: PlanStep) => s.safety_risk === 'low').length}</span> low risk</span>
            <span><span className="text-amber font-500">{steps.filter((s: PlanStep) => s.safety_risk === 'medium').length}</span> medium risk</span>
            <span><span className="text-red font-500">{steps.filter((s: PlanStep) => s.safety_risk === 'high').length}</span> high risk</span>
            {plan.requires_confirmation && (
              <span className="text-amber ml-auto">⚠ Requires confirmation</span>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {(isExec || isDone) && (
        <div className={`bg-s2 rounded-lg p-3 border ${isDone ? 'border-green/20' : 'border-border'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-500 ${isDone ? 'text-green' : 'text-cyan'}`}>
              {isDone ? '✓ Execution complete' : `Step ${executionState.currentStep} of ${total}`}
            </span>
            <span className={`text-sm font-600 ${isDone ? 'text-green' : 'text-cyan'}`}>
              {done}/{total}
            </span>
          </div>
          <div className="h-2 bg-s1 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-500
                ${isDone ? 'bg-green' : 'bg-cyan'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Safety review ── */}
      {review && <SafetyBanner review={review} />}

      {/* Steps */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-600 text-ntext">Execution plan</h2>
          <button
            onClick={() => setShowJson(!showJson)}
            className="text-xs text-dim hover:text-cyan transition-colors px-2 py-1"
          >
            {showJson ? 'Hide debug' : 'Show debug'}
          </button>
        </div>

        {showJson ? (
          <div className="bg-s2 border border-border rounded-lg p-3 overflow-auto max-h-72">
            <pre className="bg-pink font-mono text-xs text-muted whitespace-pre-wrap m-0">
              {JSON.stringify(plan, null, 2)}
            </pre>
          </div>
        ) : (
          <div className="flex flex-col">
            {steps.map((step: PlanStep, i: number) => (
              <TimelineStep
                key={step.step_number}
                step={step}
                status={getStatus(step.step_number)}
                index={i}
                result={executionState.stepResults[step.step_number]}
                isLast={i === steps.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Summary ── */}
      {(isDone || isFail) && executionState.summary && (
        <SummaryCard summary={executionState.summary} failed={isFail} />
      )}

      {/* Action buttons */}
      {!isExec && !isDone && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onConfirm}
            disabled={review?.verdict === 'UNSAFE' || reviewing}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-500 transition-all duration-200
              disabled:opacity-50 disabled:cursor-not-allowed
              ${review?.verdict === 'UNSAFE' || reviewing
                ? 'bg-s3 border border-border text-muted'
                : 'bg-green/10 border border-green/30 text-green shadow-[0_0_15px_rgba(0,255,163,0.08)]'
              }`}
          >
            {reviewing ? (
              <>
                <svg className="spin-fast" width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="12 24" strokeLinecap="round"/>
                </svg>
                Checking safety...
              </>
            ) : (
              <>Execute plan</>
            )}
          </button>
          {isFail && (
            <span className="text-xs text-red">
              Failed at step {executionState.failedStep}
            </span>
          )}
        </div>
      )}

      {isExec && (
        <button
          onClick={onStop}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-500
            bg-red text-white transition-all duration-200 hover:bg-red/90"
        >
          Stop execution
        </button>
      )}
    </div>
  )
}

// ── Timeline Step ─────────────────────────────────────────────────────────────
function TimelineStep({
  step, status, index, result, isLast,
}: {
  step: PlanStep; status: StepStatus; index: number
  result: StepResult | undefined; isLast: boolean
}) {
  const [open, setOpen] = useState(false)
  const running = status === 'running'
  const done    = status === 'complete'
  const error   = status === 'error'
  const pending = status === 'pending'

  return (
    <div className="flex gap-0">

      {/* Spine */}
      <div className="flex flex-col items-center w-8 flex-shrink-0">
        <div className="relative z-[2]">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-500 transition-all duration-300 flex-shrink-0"
            style={{
              background: done ? '#28a745' : error ? '#dc3545' : running ? 'transparent' : '#f0f0f0',
              border: `2px solid ${done ? '#28a745' : error ? '#dc3545' : running ? '#0066cc' : '#e0e0e0'}`,
              color: done ? 'white' : error ? 'white' : running ? '#0066cc' : '#999',
            }}
          >
            {done ? (
              <span>✓</span>
            ) : error ? (
              <span>✗</span>
            ) : running ? (
              <svg className="spin-fast" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="12 24" strokeLinecap="round"/>
              </svg>
            ) : (
              <span>{step.step_number}</span>
            )}
          </div>
        </div>

        {!isLast && (
          <div className="flex-1 w-0.5 bg-border relative overflow-hidden min-h-3" />
        )}
      </div>

      {/* Card */}
      <div
        onClick={() => !pending && setOpen(o => !o)}
        className={`flex-1 ml-3 relative transition-all duration-300 rounded-lg border
          ${pending ? 'cursor-default' : 'cursor-pointer'}
          ${done ? 'bg-green/5 border-green/20' : error ? 'bg-red/5 border-red/20' : running ? 'bg-cyan/5 border-cyan/20' : 'bg-white border-border'}
        `}
      >
        {/* Row */}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-6 h-6 rounded-md bg-s2 flex items-center justify-center text-sm flex-shrink-0">
            {CAP_ICON[step.capability] ?? '⚙️'}
          </div>

          <div className="flex-1 min-w-0">
            <div className={`text-sm font-500 truncate
              ${running ? 'text-cyan' : done ? 'text-green' : error ? 'text-red' : 'text-ntext'}`}>
              {step.description}
            </div>
            <div className="text-xs text-muted mt-0.5">{step.capability}</div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {step.safety_risk && (
              <span className={`text-xs px-2 py-1 rounded border
                ${step.safety_risk === 'high'   ? 'text-red bg-red/10 border-red/20'   :
                  step.safety_risk === 'medium' ? 'text-amber bg-amber/10 border-amber/20' :
                                                  'text-green bg-green/10 border-green/20' }`}>
                {step.safety_risk}
              </span>
            )}
            {running && <span className="text-xs text-cyan font-500">Running...</span>}
            {done    && <span className="text-xs text-green font-500">✓ Done</span>}
            {error   && <span className="text-xs text-red font-500">✗ Failed</span>}
            {!pending && (
              <span className="text-muted text-xs">{open ? '▲' : '▼'}</span>
            )}
          </div>
        </div>

        {/* Expandable */}
        {open && !pending && (
          <div className="border-t border-border px-3 py-2 slide-up-anim">
            {running && (
              <div className="flex items-center gap-2">
                <svg className="spin-fast" width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="12 24" strokeLinecap="round"/>
                </svg>
                <span className="text-xs text-cyan">Processing...</span>
              </div>
            )}
            {done && result && (
              <div className="flex flex-col gap-2">
                <div className="text-xs text-muted">
                  <span className="text-green">✓</span> Step completed
                  {result.message && <span className="ml-2">· {result.message}</span>}
                </div>
                {result.warning && (
                  <div className="text-xs text-amber bg-amber/10 border border-amber/20 rounded px-2 py-1.5">
                    ⚠ {result.warning}
                  </div>
                )}
              </div>
            )}
            {error && (
              <div className="text-xs text-red">
                ✗ Step failed — check activity log for details
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Safety Banner ─────────────────────────────────────────────────────────────
function SafetyBanner({ review }: { review: ReviewResult }) {
  const ok = review.verdict === 'SAFE', bad = review.verdict === 'UNSAFE'
  return (
    <div className={`rounded-lg p-3 border
      ${bad ? 'border-red/20 bg-red/10'   :
        ok  ? 'border-green/20 bg-green/10' :
              'border-amber/20 bg-amber/10' }`}>
      <div className={`flex items-center gap-2 text-xs font-500 flex-wrap
        ${bad ? 'text-red' : ok ? 'text-green' : 'text-amber'}
        ${review.recommendation ? 'mb-2' : ''}`}>
        <span>{bad ? '✗' : ok ? '✓' : '⚠'} Safety: {review.verdict}</span>
        <span className="ml-auto text-xs opacity-65">{review.confidence}% confidence</span>
      </div>
      {review.recommendation && (
        <p className="text-xs text-muted m-0">{review.recommendation}</p>
      )}
      {review.risks?.length > 0 && review.risks[0] !== 'none' && (
        <ul className="mt-2 p-0 list-none space-y-1">
          {review.risks.map((r: string, i: number) => (
            <li key={i} className="text-xs text-muted">· {r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Summary Card ──────────────────────────────────────────────────────────────
function SummaryCard({ summary, failed }: { summary: ExecutionSummary; failed: boolean }) {
  return (
    <div className={`rounded-lg p-4 border slide-up-anim
      ${failed ? 'border-red/20 bg-red/10' : 'border-green/20 bg-green/10'}`}>
      <div className={`text-sm font-600 mb-4 ${failed ? 'text-red' : 'text-green'}`}>
        {failed ? '✗ Execution failed' : '✓ All steps completed'}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total steps', value: summary.total, color: 'text-ntext' },
          { label: 'Successful', value: summary.success, color: 'text-green' },
          { label: 'Duration', value: `${(summary.duration/1000).toFixed(1)}s`, color: 'text-cyan' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <div className="text-xs text-muted mb-1">{label}</div>
            <div className={`text-xl font-600 ${color}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
