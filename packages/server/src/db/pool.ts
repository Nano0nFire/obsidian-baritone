import pg from 'pg';

export interface Queryable {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type TxFn<T> = (client: Queryable) => Promise<T>;

export class PgDatabase {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query(text, params as unknown[] | undefined) as unknown as Promise<{ rows: T[]; rowCount: number | null }>;
  }

  async withTx<T>(fn: TxFn<T>, maxRetries = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await fn(client as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        lastError = error;
        if (!isSerializationFailure(error) || attempt === maxRetries - 1) throw error;
        await delay(25 * 2 ** attempt);
      } finally {
        client.release();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('transaction failed');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '40001';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
