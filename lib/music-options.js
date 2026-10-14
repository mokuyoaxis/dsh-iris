/** Music caller controls; generation parameters remain in the prompt. */
export function normalizeMusicOptions(input = {}) {
  const integer = (field, fallback, min, max) => {
    if (input[field] !== undefined && !['number', 'string'].includes(typeof input[field])) {
      throw new TypeError(`${field} 必须是整数`);
    }
    const value = input[field] === undefined ? fallback : Number(input[field]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(`${field} 必须是 ${min}–${max} 的整数`);
    }
    return value;
  };
  return Object.freeze({
    timeoutMs: integer('timeout_ms', 300000, 1, 3600000),
    retry502: integer('retry_502', 2, 0, 5),
    retryDelayMs: integer('retry_delay_ms', 5000, 0, 60000)
  });
}
