import { storeContract } from "./fixtures/store-contract";
import { openTestStore } from "./fixtures/stores";

storeContract("local sqlite", (options) => openTestStore(":memory:", options));
