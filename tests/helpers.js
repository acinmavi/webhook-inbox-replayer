const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function createTempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `webhook-inbox-replayer-${name}-`));
  return path.join(dir, `${crypto.randomUUID()}.db`);
}

function waitFor(fn, timeoutMs = 3000, intervalMs = 20) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    async function tick() {
      try {
        const result = await fn();
        if (result) {
          resolve(result);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }

      setTimeout(tick, intervalMs);
    }

    tick();
  });
}

module.exports = {
  createTempDbPath,
  waitFor
};
