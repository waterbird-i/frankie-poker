// Runnable entry point: `npm run server`.
//
// Kept separate from server/app.ts so that importing the library (in tests)
// never opens a port.

import { startServer } from "./app";

const running = await startServer();

const shutdown = async (signal: string) => {
  console.log(`[server] ${signal} received, shutting down`);
  await running.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
