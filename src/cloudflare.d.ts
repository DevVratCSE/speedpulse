interface D1Meta {
  changes?: number;

  last_row_id?:
    | number
    | string;

  [key: string]: unknown;
}


interface D1Result<
  T = Record<string, unknown>
> {
  success?: boolean;

  results?: T[];

  meta: D1Meta;

  error?: string;
}


interface D1PreparedStatement {
  bind(
    ...values: unknown[]
  ): D1PreparedStatement;

  first<
    T = Record<string, unknown>
  >(): Promise<T | null>;

  all<
    T = Record<string, unknown>
  >(): Promise<D1Result<T>>;

  run<
    T = Record<string, unknown>
  >(): Promise<D1Result<T>>;
}


interface D1Database {
  prepare(
    query: string
  ): D1PreparedStatement;

  batch<
    T = Record<string, unknown>
  >(
    statements:
      D1PreparedStatement[]
  ): Promise<D1Result<T>[]>;
}


interface Fetcher {
  fetch(
    input:
      | RequestInfo
      | URL,

    init?: RequestInit
  ): Promise<Response>;
}


interface ScheduledController {
  cron: string;
  scheduledTime: number;
}


interface ExecutionContext {
  waitUntil(
    promise:
      Promise<unknown>
  ): void;

  passThroughOnException(): void;
}


interface QueueSendOptions {
  delaySeconds?: number;
}


interface Queue<
  T = unknown
> {
  send(
    body: T,
    options?: QueueSendOptions
  ): Promise<void>;
}


interface MessageRetryOptions {
  delaySeconds?: number;
}


interface Message<
  T = unknown
> {
  body: T;

  ack(): void;

  retry(
    options?:
      MessageRetryOptions
  ): void;
}


interface MessageBatch<
  T = unknown
> {
  queue: string;

  messages:
    Message<T>[];

  ackAll(): void;

  retryAll(
    options?:
      MessageRetryOptions
  ): void;
}


interface MessageSendRequest<
  T = unknown
> {
  body: T;
  delaySeconds?: number;
  contentType?: string;
}


interface QueueSendBatchOptions {
  delaySeconds?: number;
}


interface Queue<
  T = unknown
> {
  sendBatch(
    messages:
      Iterable<
        MessageSendRequest<T>
      >,

    options?:
      QueueSendBatchOptions
  ): Promise<unknown>;
}


/*
 * Minimal Workers KV binding definitions used by SpeedPulse.
 */

interface KVNamespacePutOptions {
  expiration?: number;
  expirationTtl?: number;

  metadata?:
    Record<
      string,
      string
    >;
}


interface KVNamespaceGetOptions {
  type?: "text";
  cacheTtl?: number;
}


interface KVNamespace {
  get(
    key: string,

    typeOrOptions?:
      | "text"
      | KVNamespaceGetOptions
  ): Promise<
    string | null
  >;

  put(
    key: string,
    value: string,
    options?:
      KVNamespacePutOptions
  ): Promise<void>;

  delete(
    key: string
  ): Promise<void>;
}


