/**
 * Logger utility with timestamp support
 */

function getTimestamp(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatMessage(prefix: string, message: string): string {
  return `[${getTimestamp()}] [${prefix}] ${message}`;
}

export const logger = {
  log(prefix: string, message: string): void {
    console.log(formatMessage(prefix, message));
  },

  info(prefix: string, message: string): void {
    console.info(formatMessage(prefix, message));
  },

  warn(prefix: string, message: string): void {
    console.warn(formatMessage(prefix, message));
  },

  error(prefix: string, message: string, error?: unknown): void {
    console.error(formatMessage(prefix, message));
    if (error) {
      console.error(error);
    }
  },
};
