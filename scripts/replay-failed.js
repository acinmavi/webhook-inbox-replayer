const config = require("../src/config");
const logger = require("../src/utils/logger");
const { createStore } = require("../src/inbox/store");
const { createReplayService } = require("../src/replay/replay-service");

function parseArgs(argv) {
  const args = { all: false, id: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--all") {
      args.all = true;
    }
    if (value === "--id") {
      args.id = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = createStore({ dbPath: config.dbPath });
  const replayService = createReplayService({ store, logger });

  let result;
  if (args.all) {
    result = replayService.replayAll();
  } else if (args.id) {
    const replayed = replayService.replayById(args.id);
    result = replayed ? [replayed] : [];
  } else {
    console.error("Usage: node scripts/replay-failed.js --all | --id <eventId>");
    process.exitCode = 1;
    store.close();
    return;
  }

  console.log(JSON.stringify({ replayed: result }, null, 2));
  store.close();
}

main();
