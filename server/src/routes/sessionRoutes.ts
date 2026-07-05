import { Router } from 'express'
import { getSession } from '../services/sessionService'

export const sessionRoutes = Router()

sessionRoutes.get('/api/session/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  res.json(session)
})
