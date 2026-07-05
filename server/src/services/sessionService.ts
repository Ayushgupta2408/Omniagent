import { v4 as uuidv4 } from 'uuid';
import { Plan, Session } from '../types';

// ─── In-Memory Session Store ──────────────────────────────────────────────────

const sessions = new Map<string, Session>();

// ─── Public API ───────────────────────────────────────────────────────────────

export function createSession(plan: Plan): { sessionId: string; session: Session } {
  const sessionId = uuidv4();
  const session: Session = { plan, status: 'planned', currentStep: 0, stopped: false };
  sessions.set(sessionId, session);
  return { sessionId, session };
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}
export function getSessions(): Array<{ sessionId: string; session: Session }> {
  return Array.from(sessions.entries()).map(([sessionId, session]) => ({ sessionId, session }))
}
