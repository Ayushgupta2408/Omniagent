import { tryAutoFixBeforeRetry } from '../utils/autoFix';
import { replanFromStep } from '../ai/planner';
import { executeStep, getLivePage } from '../executor/stepExecutor';
import { logExecution } from '../utils/Executionlogger';
import { appendMemory } from '../utils/memory';
import { broadcast } from './websocketService';
import { sleep } from './workarounds';
import {
  Session,
  StepExecutionResult,
  PlanStep,
} from '../types';
import { markUrlBlocked, getBlockedUrls, isUrlBlocked } from '../executor/blockedUrlTracker';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

// ─── Main Execution Loop ─────────────────────────────────────────────────────

/**
 * PATCH for server.ts — executeAllSteps function
 * 
 * Replace the existing executeAllSteps function in server/src/server.ts
 * with this version. Three changes marked with ── NEW ──
 *
 *  
 */

export async function executeAllSteps(sessionId: string, session: Session): Promise<void> {
  const { plan } = session;
  const results: StepExecutionResult[] = [];
  let totalFailed = 0;
  const startTime = Date.now();

  for (let i = 0; i < plan.steps.length; i++) {
    if (session.stopped) break;

    const step = plan.steps[i];
    session.currentStep = i + 1;

    broadcast({ type: 'step_start', sessionId, stepNumber: step.step_number, step });

    if (step.safety_risk === 'high') {
      broadcast({
        type:       'safety_check',
        sessionId,
        stepNumber: step.step_number,
        message:    `High-risk step: ${step.description}`,
      });
      await sleep(1000);
    }

    // ── NEW: Skip immediately if this step targets a known blocked URL ───────
    if (step.capability === 'browser_open' && step.parameters?.url) {
      const resolvedUrl = step.parameters.url.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        // We can't resolve templates here, but we can check the raw URL
        return match;
      });
      // Only check non-template URLs
      if (!resolvedUrl.includes('{{')) {
        if (isUrlBlocked(resolvedUrl)) {
          console.log(`[Server] Skipping known bot-blocked URL: ${resolvedUrl}`);
          broadcast({
            type: 'safety_check',
            sessionId,
            stepNumber: step.step_number,
            message: `Skipping bot-blocked URL: ${resolvedUrl}`,
          });
          results.push({
            stepNumber: step.step_number,
            success: false,
            error: `Skipped — URL is bot-blocked this session: ${resolvedUrl}`,
          });
          totalFailed++;
          continue;
        }
      }
    }

    let lastError = '';
    let succeeded = false;

    // ── Retry loop ────────────────────────────────────────────────────────
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (session.stopped) break;

      if (attempt > 0) {
        const fixApplied = await tryAutoFixBeforeRetry(step, lastError, broadcast);

        if (fixApplied) {
          broadcast({
            type: 'planning',
            message: `✓ Auto-fix applied (attempt ${attempt + 1}): ${fixApplied}`,
          });
        } else {
          broadcast({
            type: 'safety_check',
            sessionId,
            stepNumber: step.step_number,
            message: `Retrying step ${step.step_number} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — no auto-fix found...`,
          });
        }

        // ── NEW: Don't retry bot-blocked steps — fail fast ───────────────
        if (
          lastError.toLowerCase().includes('bot detection') ||
          lastError.toLowerCase().includes('bot_detection') ||
          lastError.toLowerCase().includes('just a moment')
        ) {
          console.log(`[Server] Bot detection confirmed on attempt ${attempt + 1} — not retrying further`);
          break;
        }

        await sleep(1500 * attempt);
      }

      const stepStartTime = Date.now();

      try {
        const result   = await executeStep(step);
        const duration = Date.now() - stepStartTime;

        results.push({ stepNumber: step.step_number, success: true, result, duration });
        broadcast({ type: 'step_complete', sessionId, stepNumber: step.step_number, result, duration });
        succeeded = true;
        break;
      } catch (err: unknown) {
        lastError = (err as Error).message;
        console.warn(`[Executor] Step ${step.step_number} attempt ${attempt + 1} failed:`, lastError);

        // ── NEW: Register bot-blocked URL immediately on first detection ──
        if (
          lastError.toLowerCase().includes('bot detection') ||
          lastError.toLowerCase().includes('bot_detection')
        ) {
          // Extract the blocked URL from the error message
          const urlMatch = lastError.match(/Bot detection active on (https?:\/\/[^\s]+)/);
          const blockedUrl = urlMatch ? urlMatch[1] : (step.parameters?.url ?? '');
          if (blockedUrl) {
            markUrlBlocked(blockedUrl);
            broadcast({
              type: 'safety_check',
              sessionId,
              stepNumber: step.step_number,
              message: `Bot-blocked URL registered: ${new URL(blockedUrl).hostname} — will skip in future steps`,
            });
          }
          // Don't waste retries on a blocked URL — break immediately
          break;
        }
      }
    }

    if (!succeeded) {
      broadcast({ type: 'step_error', sessionId, stepNumber: step.step_number, error: lastError });
      results.push({ stepNumber: step.step_number, success: false, error: lastError });
      totalFailed++;

      // ── Mid-execution replanning ──────────────────────────────────────
      const isLastStep = i >= plan.steps.length - 1;

      if (!isLastStep) {
        const livePage = getLivePage();

        if (livePage) {
          try {
            const pageUrl   = livePage.url();
            const pageTitle = await livePage.title().catch(() => '');

            const completedSteps = plan.steps.slice(0, i).map((s) => ({
              description: s.description,
              capability:  s.capability,
            }));

            const remainingGoal = plan.steps
              .slice(i + 1)
              .map((s) => s.description)
              .join('; ');

            broadcast({
              type:    'planning',
              message: `Step ${step.step_number} failed — re-planning from current page...`,
            });

            console.log(
              `[Server] Attempting mid-execution replan after step ${step.step_number} failed.`
            );

            // ── NEW: Pass blocked URLs into the replanner ─────────────────
            const currentBlockedUrls = getBlockedUrls();

            if (currentBlockedUrls.length > 0) {
              console.log(`[Server] Passing ${currentBlockedUrls.length} blocked URL(s) to replanner: ${currentBlockedUrls.join(', ')}`);
            }

            const newPlan = await replanFromStep(
              plan.summary,
              completedSteps,
              step,
              lastError,
              pageUrl,
              pageTitle,
              remainingGoal,
              currentBlockedUrls,  // ← NEW: pass blocked URLs
            );

            if (newPlan && newPlan.steps.length > 0) {
              const numberedNewSteps = newPlan.steps.map((s, idx) => ({
                ...s,
                step_number: step.step_number + idx + 1,
              }));

              plan.steps.splice(i + 1, plan.steps.length - (i + 1), ...numberedNewSteps);

              broadcast({ type: 'plan_ready', sessionId, plan });
              broadcast({
                type:    'planning',
                message: `Re-planned: ${newPlan.steps.length} new step${newPlan.steps.length !== 1 ? 's' : ''} generated`,
              });

              console.log(
                `[Server] Re-plan successful — inserted ${newPlan.steps.length} new steps. ` +
                `Execution continues.`
              );
            } else {
              console.warn('[Server] Re-plan returned no steps — continuing with original remaining steps');
            }
          } catch (replanErr) {
            console.warn('[Server] Re-planning threw an error:', (replanErr as Error).message);
          }
        } else {
          console.warn('[Server] getLivePage() returned null — cannot replan (no live browser context)');
        }
      }

      await sleep(500);
    }

    await sleep(300);
  }

  if (!session.stopped) {
    const successCount = results.filter((r) => r.success).length;
    const totalDuration = Date.now() - startTime;
    const overallSuccess = totalFailed < results.length / 2;
    session.status = totalFailed === results.length ? 'failed' : 'completed';

    broadcast({
      type: 'execution_complete',
      sessionId,
      results,
      summary: {
        total:    plan.steps.length,
        success:  successCount,
        failed:   totalFailed,
        duration: totalDuration,
      },
    });

    await logExecution({
      timestamp:      new Date().toISOString(),
      sessionId,
      prompt:         session.plan.summary,
      intent:         session.plan.intent,
      provider:       process.env.AI_PROVIDER ?? 'groq',
      totalSteps:     plan.steps.length,
      steps:          results.map((r, idx) => ({
        stepNumber:   r.stepNumber,
        capability:   plan.steps[idx]?.capability ?? 'unknown',
        description:  plan.steps[idx]?.description ?? '',
        success:      r.success,
        errorMessage: r.error,
        durationMs:   r.duration ?? 0,
        retryCount:   0,
        pageUrl:      r.result?.url as string | undefined,
        strategy:     r.result?.strategy as string | undefined,
      })),
      overallSuccess,
      successRate:    results.length > 0
        ? (results.length - totalFailed) / results.length
        : 0,
      durationMs: totalDuration,
    });
    await appendMemory(plan.intent, plan.summary, overallSuccess, plan.steps.length);
  }
}
