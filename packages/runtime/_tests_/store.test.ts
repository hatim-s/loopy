import { afterEach } from "bun:test";
import { storeContract } from "./fixtures/store-contract";
import { createTestStores } from "./fixtures/stores";

const { openTestStore, closeTestStores } = createTestStores();

afterEach(closeTestStores);

storeContract("local sqlite", (options) => openTestStore(":memory:", options));
