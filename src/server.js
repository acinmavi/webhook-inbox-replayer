const config = require("./config");
const { createApplication } = require("./app");
const logger = require("./utils/logger");

async function main() {
  const runtime = createApplication({
    dbPath: config.dbPath,
    worker: config.worker,
    logger
  });

  await runtime.start();

  const server = runtime.app.listen(config.port, () => {
    logger.info("server_started", {
      port: config.port,
      dbPath: config.dbPath
    });
  });

  async function shutdown() {
    server.close(async () => {
      await runtime.stop();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
