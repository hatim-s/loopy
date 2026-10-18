import { parseWorktreeList as run } from "../../shell/parse/git.js";

export default (...args: Parameters<typeof run>) => run(...args);
