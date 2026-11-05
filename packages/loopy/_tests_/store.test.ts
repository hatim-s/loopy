import { afterEach } from "bun:test";
import { storeContract } from "./store-contract.js";
import { createTestStores } from "./store-fixture.js";

const { openTestStore, closeTestStores } = createTestStores();

afterEach(closeTestStores);

storeContract("sqlite", (options) => openTestStore(":memory:", options?.now, options));
