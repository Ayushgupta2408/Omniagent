import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { validateEnv } from './config/env';
import { setupWebSocket } from './services/websocketService';
import { healthRoutes } from './routes/healthRoutes';
import { planRoutes } from './routes/planRoutes';
import { executionRoutes } from './routes/executionRoutes';
import { sessionRoutes } from './routes/sessionRoutes';

validateEnv();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

setupWebSocket(wss);

app.use(healthRoutes);
app.use(planRoutes);
app.use(executionRoutes);
app.use(sessionRoutes);

const PORT = parseInt(process.env.PORT ?? '3001', 10);
server.listen(PORT, () => {
  console.log(`
  HTTP : http://localhost:${PORT}
  WS   : ws://localhost:${PORT}
  AI   : ${(process.env.AI_PROVIDER ?? 'groq').padEnd(28)}
  `);
});
