// GET /health — liveness endpoint. EXEMPT from the origin-secret validator
// (deploy health-checks arrive via localhost without the CloudFront header).
import { Router } from 'express';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'app',
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});
