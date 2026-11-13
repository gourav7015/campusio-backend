import { config } from './config.js';

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = levels[process.env.LOG_LEVEL || (config.env === 'test' ? 'silent' : 'info')] ?? 20;

function write(level, msg, fields) {
  if (levels[level] < threshold) return;
  const line = { level, time: new Date().toISOString(), msg, ...fields };
  (level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};
