// Exercise the real proxy/Doctor checks while the runtime collects temporary
// timeout sources. The caller starts this process with --expose-gc.
if (typeof globalThis.gc !== 'function') throw new Error('Doctor GC fixture requires --expose-gc');
const timer = setInterval(() => globalThis.gc(), 100);
try { await import('../network-doctor.mjs'); }
finally { clearInterval(timer); }
