export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;
export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
  context?: LogContext;
}

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.LOG_LEVEL, 'info');
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const baseContext = sanitizeContext(options.context ?? {});

  const write = (entryLevel: LogLevel, message: string, context: LogContext = {}): void => {
    if (severity[entryLevel] < severity[level]) return;
    const entry = sanitizeContext({ ...baseContext, ...context, level: entryLevel, timestamp: now().toISOString(), message });
    sink(JSON.stringify(entry), entryLevel);
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (context) => createLogger({ level, sink, now, context: { ...baseContext, ...context } }),
  };
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : fallback;
}

function defaultSink(line: string, level: LogLevel): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function sanitizeContext(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    out[key] = serializeValue(value);
  }
  return out;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    const out: LogContext = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) out[key] = serializeValue(child);
    }
    return out;
  }
  return value;
}
