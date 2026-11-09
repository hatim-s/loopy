export default ({ diff, instructions }: { diff: string; instructions?: string }) => ({
  prompt: `${instructions ?? "Report actionable findings."}\n${diff}`,
});
