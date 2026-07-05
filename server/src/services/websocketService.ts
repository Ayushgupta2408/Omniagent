import WebSocket, { WebSocketServer } from 'ws';
import { WsMessage } from '../types';

// ─── Module State ─────────────────────────────────────────────────────────────

let wssInstance: WebSocketServer | null = null;

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupWebSocket(wss: WebSocketServer): void {
  wssInstance = wss;

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'connected', message: 'NEXUS Agent Online' } satisfies WsMessage));
    ws.on('close', () => console.log('[WS] Client disconnected'));
    ws.on('error', (err) => console.error('[WS] Error:', err));
  });
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

export function broadcast(data: WsMessage): void {
  if (!wssInstance) return;
  const payload = JSON.stringify(data);
  wssInstance.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}
