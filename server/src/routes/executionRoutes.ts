import { Router } from 'express'
import { getSession } from '../services/sessionService'
import { executeAllSteps } from '../services/executionService'
import { broadcast } from '../services/websocketService'
import { ExecuteRequest, StopRequest } from '../types'

export const executionRoutes = Router()

executionRoutes.post('/api/execute', async (req, res) => {
  try {
    const { sessionId } = req.body as ExecuteRequest
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }

    const session = getSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    session.status = 'executing'
    session.stopped = false

    broadcast({ type: 'execution_start', sessionId, totalSteps: session.plan.steps.length })
    res.json({ status: 'executing', message: 'Execution started' })
    void executeAllSteps(sessionId, session)
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message })
  }
})

executionRoutes.post('/api/stop', (req, res) => {
  const { sessionId } = req.body as StopRequest
  const session = getSession(sessionId)
  if (session) {
    session.stopped = true
    broadcast({ type: 'execution_stopped', sessionId })
  }
  res.json({ status: 'stopped' })
})
