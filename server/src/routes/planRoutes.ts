import { Router } from 'express'
import { planTask } from '../ai/planner'
import { reviewPlan } from '../ai/reviewer'
import { createSession } from '../services/sessionService'
import { broadcast } from '../services/websocketService'
import { PlanRequest, ReviewRequest } from '../types'

export const planRoutes = Router()

planRoutes.post('/api/plan', async (req, res) => {
  try {
    const { prompt } = req.body as PlanRequest
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }

    broadcast({ type: 'planning', message: 'Analyzing your request...' })
    const plan = await planTask(prompt)
    const { sessionId } = createSession(plan)

    broadcast({ type: 'plan_ready', sessionId, plan })
    res.json({ sessionId, plan })
  } catch (err: unknown) {
    const e = err as Error
    broadcast({ type: 'error', message: e.message })
    res.status(500).json({ error: e.message })
  }
})

planRoutes.post('/api/review', async (req, res) => {
  try {
    const { plan } = req.body as ReviewRequest
    if (!plan) {
      res.status(400).json({ error: 'plan is required' })
      return
    }
    const review = await reviewPlan(plan)
    res.json(review)
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message })
  }
})
