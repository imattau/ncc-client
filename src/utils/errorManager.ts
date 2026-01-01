export type Severity = "info" | "warning" | "error";

export interface AppError {
  id: string;
  message: string;
  source?: string;
  severity: Severity;
  details?: unknown;
  timestamp: number;
}

export type ErrorListener = (errors: AppError[]) => void;

const MAX_ERRORS = 60;

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ErrorManager {
  private readonly listeners = new Set<ErrorListener>();
  private readonly errors: AppError[] = [];

  report(error: Omit<AppError, "timestamp" | "id">): AppError {
    const normalized: AppError = {
      id: createId(),
      timestamp: Date.now(),
      ...error
    };
    this.errors.unshift(normalized);
    if (this.errors.length > MAX_ERRORS) {
      this.errors.pop();
    }
    this.emit();
    return normalized;
  }

  clear() {
    this.errors.length = 0;
    this.emit();
  }

  subscribe(listener: ErrorListener) {
    this.listeners.add(listener);
    listener([...this.errors]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const snapshot = [...this.errors];
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

export const appErrorManager = new ErrorManager();
