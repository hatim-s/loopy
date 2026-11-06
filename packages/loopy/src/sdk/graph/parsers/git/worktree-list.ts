import { parseWorktreeList as run } from "../../../shell/parse/git";

export default (...args: Parameters<typeof run>) => run(...args);
