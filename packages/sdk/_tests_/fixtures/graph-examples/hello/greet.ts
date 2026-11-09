export default ({ name, enthusiastic }: { name: string; enthusiastic?: boolean }) => ({
  greeting: `Hello, ${name}${enthusiastic ? "!" : "."}`,
});
