export const SERIALIZATION_FAILURE = '40001'

export interface RetryPolicy {
  attempts: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 8 }

export function retryableSqlError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  return (err as { code: unknown }).code === SERIALIZATION_FAILURE
}

export async function withSerializableRetry<T>(
  op: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.attempts))
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await op()
    } catch (err) {
      last = err
      if (!retryableSqlError(err) || i === attempts - 1) throw err
    }
  }
  throw last
}
