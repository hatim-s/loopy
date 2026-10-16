export function race<T>(functions: readonly (() => Promise<T>)[]): Promise<T> {
  return Promise.race(functions.map((fn) => fn()));
}
