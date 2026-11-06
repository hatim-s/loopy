import { afterEach } from "bun:test";
import { storeContract } from "./store-contract";
import { createTestStores } from "./store-fixture";

const { openTestStore, closeTestStores } = createTestStores();

afterEach(closeTestStores);

storeContract("sqlite", (options) => openTestStore(":memory:", options?.now, options));
