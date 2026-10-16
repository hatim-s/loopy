export function duration(start: string, end: number): string {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function timestamp(value: string): string {
  return new Date(value).toLocaleString();
}
