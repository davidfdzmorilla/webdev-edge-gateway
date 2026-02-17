type Level = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(service: string) {
  const log = (level: Level, msg: string, meta?: object) => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service,
        message: msg,
        ...meta,
      })
    );
  };
  return {
    debug: (msg: string, meta?: object) => log('debug', msg, meta),
    info: (msg: string, meta?: object) => log('info', msg, meta),
    warn: (msg: string, meta?: object) => log('warn', msg, meta),
    error: (msg: string, meta?: object) => log('error', msg, meta),
  };
}
