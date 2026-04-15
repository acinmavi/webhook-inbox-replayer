function log(level, message, fields) {
  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    ...fields
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

module.exports = {
  info(message, fields) {
    log("info", message, fields);
  },
  warn(message, fields) {
    log("warn", message, fields);
  },
  error(message, fields) {
    log("error", message, fields);
  }
};
