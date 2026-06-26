import { createRequire } from "module";
const require = createRequire(import.meta.url);
const winston = require("winston");

import path from "path";
import fs from "fs";

const LOG_DIR = "/tmp/logs";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const securityLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, "security.log"),
      maxsize:  5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

export default securityLogger;
