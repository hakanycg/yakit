import pino from "pino";
import { isProd } from "../config.js";

export const logger = pino({
  level: isProd ? "info" : "debug",
  redact: ["req.headers.cookie", "req.headers.authorization"],
});
