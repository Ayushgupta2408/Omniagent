'use client'
import { useAgentWorkflow } from '@/hooks/useAgentWorkflow'
import Header from '@/components/Header'
import PromptInput from '@/components/PromptInput'
import PlanDisplay from '@/components/PlanDisplay'
import ActivityLog from '@/components/ActivityLog'
import AgentStatusBar from '@/components/AgentStatusBar'
import StatCard from '@/components/StatCard'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'

export default function HomePage() {
  const {
    connected,
    loading,
    reviewing,
    plan,
    review,
    sessionId,
    events,
    exec,
    totalSteps,
    handlePlan,
    handleExecute,
    handleStop,
    handleNew,
  } = useAgentWorkflow(WS_URL)

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <Header connected={connected} />

      {(exec.status === 'executing' || exec.status === 'completed') && (
        <AgentStatusBar executionState={exec} totalSteps={totalSteps} />
      )}

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-5">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 items-start">

          <div className="flex flex-col gap-4">
            {!plan && (
              <div className="mb-2">
                <h1 className="font-display text-[32px] font-600 text-ntext leading-tight mb-2">
                  What would you like to automate?
                </h1>
                <p className="text-[14px] text-muted leading-relaxed">
                  Describe your task in plain English. Nexus will generate and execute an intelligent plan.
                </p>
              </div>
            )}

            {plan && (
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={handleNew}
                  className="text-[14px] text-cyan hover:text-ntext transition-colors bg-transparent border-none cursor-pointer px-2 py-1 rounded hover:bg-s1"
                >
                  ← Back
                </button>
              </div>
            )}

            {!plan && (
              <div className="bg-s1 border border-border rounded-lg p-5">
                <PromptInput onSubmit={handlePlan} loading={loading} />
              </div>
            )}

            {loading && (
              <div className="bg-s1 border border-border rounded-lg p-5">
                <div className="flex items-center gap-2 text-[14px] text-muted mb-4">
                  <svg className="spin-fast" width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="12 24" strokeLinecap="round"/>
                  </svg>
                  Generating execution plan...
                </div>
                <div className="flex flex-col gap-2">
                  {[80,60,70,40].map((w, i) => (
                    <div key={i} className="h-3 rounded bg-s2" style={{ width: `${w}%` }} />
                  ))}
                </div>
              </div>
            )}

            {plan && !loading && (
              <div className="bg-s1 border border-border rounded-lg p-5">
                <PlanDisplay
                  plan={plan}
                  executionState={exec}
                  onConfirm={handleExecute}
                  onStop={handleStop}
                  reviewing={reviewing}
                  review={review}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 lg:sticky lg:top-[90px]">
            <div className="h-[560px]">
              <ActivityLog events={events} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="SESSIONS" value={sessionId ? '1' : '0'} color="text-cyan" />
              <StatCard label="WS STATUS" value={connected ? 'LIVE' : 'OFF'} color={connected ? 'text-green' : 'text-red'} />
            </div>
          </div>
        </div>
      </main>


    </div>
  )
}

