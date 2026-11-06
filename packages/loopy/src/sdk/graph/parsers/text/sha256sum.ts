import { parseSha256 as run } from "../../../shell/parse/text";

export default (...args: Parameters<typeof run>) => run(...args);
