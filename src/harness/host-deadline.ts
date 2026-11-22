// Acota también proveedores/streams inyectados que no cooperan con AbortSignal. No autoriza efectos.
export function withinSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
 return new Promise<T>((resolve, reject) => {
  const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Host operation aborted")); };
  const done = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  pending.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
  if (signal.aborted) abort();
 });
}
