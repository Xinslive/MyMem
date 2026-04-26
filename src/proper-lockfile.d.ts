declare module "proper-lockfile" {
  export interface LockOptions {
    stale?: number;
    update?: number;
    realpath?: boolean;
    retries?: unknown;
    onCompromised?: (error: Error) => void;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;
}
