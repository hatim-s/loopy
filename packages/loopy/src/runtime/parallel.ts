export function parallel<T>(functions: readonly (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(functions.map((fn) => fn()));
}
