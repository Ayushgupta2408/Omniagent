import { Router } from 'express'
import { getFailureStats } from '../utils/Executionlogger'

export const healthRoutes = Router()

healthRoutes.get('/api/health', async (_req, res) => {
  const stats = await getFailureStats()
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    provider: process.env.AI_PROVIDER ?? 'groq',
    totalRuns: stats.totalRuns,
    avgSuccessRate: `${Math.round(stats.avgSuccess * 100)}%`,
    recentTrend: stats.recentTrend,
    topFailures:
      Object.entries(stats.byCapability)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cap, n]) => `${cap}(${n})`)
        .join(', ') || 'none',
  })
})

healthRoutes.get('/api/logs', async (_req, res) => {
  const stats = await getFailureStats()
  res.json(stats)
})
