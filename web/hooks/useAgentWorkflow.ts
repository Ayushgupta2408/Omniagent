'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebSocket } from '@/hooks/useWebSocket'
import { api } from '@/lib/api'
import {
  ActivityEvent,
  ExecutionState,
  Plan,
  ReviewResult,
  WsMessage,
  WsMessageType,
} from '@/types'

const INIT_STATE: ExecutionState = {
  status: 'idle',
  currentStep: null,
  completedSteps: [],
  failedStep: null,
  stepResults: {},
  summary: null,
}

const MAX_EVENTS = 200

export function useAgentWorkflow(wsUrl: string) {
  const { connected, subscribe } = useWebSocket(wsUrl)
  const [loading, setLoading] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [exec, setExec] = useState<ExecutionState>(INIT_STATE)

  const addEvent = useCallback((type: WsMessageType, message: string) => {
    const time = new Date().toLocaleTimeString('en', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setEvents((previous) => [
      ...previous.slice(-MAX_EVENTS + 1),
      { type, message, time },
    ])
  }, [])

  const handleWsMessage = useCallback(
    (data: WsMessage) => {
      switch (data.type) {
        case 'connected':
          addEvent('connected', 'NEXUS Agent online')
          break
        case 'planning':
          addEvent('planning', data.message ?? '')
          break
        case 'plan_ready':
          addEvent('plan_ready', `Plan ready: ${data.plan?.intent} (${data.plan?.steps.length} steps)`)
          break
        case 'execution_start':
          addEvent('execution_start', `Starting execution: ${data.totalSteps} steps`)
          setExec((previous) => ({ ...previous, status: 'executing', currentStep: 1 }))
          break
        case 'step_start':
          addEvent('step_start', `Step ${data.stepNumber}: ${data.step?.description}`)
          setExec((previous) => ({ ...previous, currentStep: data.stepNumber ?? null }))
          break
        case 'step_complete':
          addEvent('step_complete', `Step ${data.stepNumber} done (${data.duration}ms)`)
          setExec((previous) => ({
            ...previous,
            completedSteps: [...previous.completedSteps, data.stepNumber!],
            stepResults:
              data.stepNumber != null && data.result
                ? { ...previous.stepResults, [data.stepNumber]: data.result }
                : previous.stepResults,
          }))
          break
        case 'step_error':
          addEvent('step_error', `Step ${data.stepNumber} failed: ${data.error}`)
          setExec((previous) => ({ ...previous, failedStep: data.stepNumber ?? null }))
          break
        case 'safety_check':
          addEvent('safety_check', data.message ?? '')
          break
        case 'execution_complete': {
          const total = data.summary?.total ?? 0
          const success = data.summary?.success ?? 0
          addEvent('execution_complete', `Complete! ${success}/${total} steps succeeded`)
          setExec((previous) => ({
            ...previous,
            status: 'completed',
            currentStep: null,
            completedSteps:
              data.results
                ? data.results.filter((result) => result.success).map((result) => result.stepNumber)
                : Array.from({ length: total }, (_, i) => i + 1).slice(0, success),
            summary: data.summary ?? null,
          }))
          break
        }
        case 'execution_failed':
          addEvent('execution_failed', `Failed at step ${data.stepNumber}: ${data.error}`)
          setExec((previous) => ({ ...previous, status: 'failed' }))
          break
        case 'execution_stopped':
          addEvent('execution_stopped', 'Execution stopped by user')
          setExec((previous) => ({ ...previous, status: 'stopped' }))
          break
        case 'error':
          addEvent('error', data.message ?? 'Unknown error')
          break
      }
    },
    [addEvent]
  )

  useEffect(() => {
    const unsubscribe = subscribe(handleWsMessage)
    return unsubscribe
  }, [subscribe, handleWsMessage])

  const handlePlan = useCallback(
    async (prompt: string) => {
      try {
        setLoading(true)
        setPlan(null)
        setReview(null)
        setSessionId(null)
        setExec(INIT_STATE)

        addEvent('planning', `Analyzing: "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`)

        const res = await api.plan(prompt)
        setPlan(res.plan)
        setSessionId(res.sessionId)
        addEvent('plan_ready', `Generated: ${res.plan.steps.length} steps`)

        setReviewing(true)
        addEvent('planning', 'Running safety review...')

        const rv = await api.review(res.plan)
        setReview(rv)
        addEvent(
          rv.verdict === 'SAFE' ? 'step_complete' : 'safety_check',
          `Safety review: ${rv.verdict} — ${rv.recommendation}`
        )
      } catch (error: unknown) {
        addEvent('error', (error as Error).message)
      } finally {
        setLoading(false)
        setReviewing(false)
      }
    },
    [addEvent]
  )

  const handleExecute = useCallback(async () => {
    if (!sessionId) return
    try {
      setExec((previous) => ({ ...previous, completedSteps: [], failedStep: null }))
      await api.execute(sessionId)
    } catch (error: unknown) {
      addEvent('error', `Execution start failed: ${(error as Error).message}`)
    }
  }, [sessionId, addEvent])

  const handleStop = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stop(sessionId)
    } catch (error: unknown) {
      addEvent('error', (error as Error).message)
    }
  }, [sessionId, addEvent])

  const handleNew = useCallback(() => {
    setPlan(null)
    setReview(null)
    setSessionId(null)
    setExec(INIT_STATE)
  }, [])

  const totalSteps = useMemo(() => plan?.steps.length ?? 0, [plan])

  return {
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
  }
}
