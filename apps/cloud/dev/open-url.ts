import { principalToken, readLocalCredentials } from "./stack/credentials";

const token = principalToken(await readLocalCredentials(), "fixtures");

console.log(`http://127.0.0.1:14872/#token=${encodeURIComponent(token)}`);
