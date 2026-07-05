'use client'

import { ExecutionState } from '@/types'

interface Props {
  executionState: ExecutionState
  totalSteps: number
}

export default function AgentStatusBar({ executionState, totalSteps }: Props) {
  const isExec = executionState.status === 'executing'
  const isDone = executionState.status === 'completed'
  const done = executionState.completedSteps.length
  const pct = isDone ? 100 : isExec && totalSteps ? Math.round((done / totalSteps) * 100) : 0

  return (
    <div className="max-w-7xl w-full mx-auto px-6 pt-4">
      <div
        className={`bg-s2 rounded-lg px-4 py-3 flex items-center gap-3 border
          ${isDone ? 'border-green/20' : 'border-border'}`}
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0
          ${isDone ? 'bg-green' : 'bg-cyan'}`}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted font-500 flex-shrink-0">
              Status
            </span>
            <span className={`text-sm ${isDone ? 'text-green' : 'text-cyan'} font-500`}>
              {isDone
                ? 'All steps complete'
                : executionState.currentStep
                ? `Step ${executionState.currentStep} of ${totalSteps}`
                : 'Starting...'}
            </span>
            <span className="ml-auto text-xs text-muted flex-shrink-0">
              {done}/{totalSteps}
            </span>
          </div>
          <div className="h-1.5 bg-s1 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-500
                ${isDone ? 'bg-green' : 'bg-cyan'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
