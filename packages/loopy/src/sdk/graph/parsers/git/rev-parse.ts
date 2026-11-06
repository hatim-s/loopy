import { parseRevParse as run } from "../../../shell/parse/git";

export default (...args: Parameters<typeof run>) => run(...args);
