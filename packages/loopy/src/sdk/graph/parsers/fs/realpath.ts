import { parseRealpath as run } from "../../../shell/parse/fs";

export default (...args: Parameters<typeof run>) => run(...args);
