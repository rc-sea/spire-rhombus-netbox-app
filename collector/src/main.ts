import { createServer } from 'node:http';
import { pino } from 'pino';
import { Collector } from './collector.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  redact: ['password', 'secret', 'cookie', 'authorization'],
});

const collector = new Collector(config, log);

if (config.healthPort > 0) {
  // Localhost only: a convenience for `docker exec` / host checks, never exposed on the LAN.
  createServer((_req, res) => {
    const hb = collector.buildHeartbeat();
    const healthy = hb.netboxStatus === 'connected' && hb.cloudStatus !== 'auth-failed';
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hb));
  }).listen(config.healthPort, '127.0.0.1', () =>
    log.info({ port: config.healthPort }, 'health endpoint on localhost'),
  );
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await collector.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

collector
  .start()
  .then(() =>
    log.info(
      { collectorId: config.collectorId, netbox: config.netbox.baseUrl },
      'collector started',
    ),
  )
  .catch((err) => {
    log.fatal({ err: (err as Error).message }, 'collector failed to start');
    process.exit(1);
  });
