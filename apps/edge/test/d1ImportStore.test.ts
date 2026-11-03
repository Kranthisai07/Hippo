import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { runImportStoreGuards, runImportStoreSuite } from "../../api/test/importStore.suite";
import { createD1ImportStore } from "../src/d1ImportStore";

// The same suite as the memory store, on D1 (SQLite here). The second run makes statements from different callers
// interleave, so the one winner of the lock does not depend on the order they happen to run in.
runImportStoreSuite("D1", () => createD1ImportStore(createSqliteD1()));
runImportStoreSuite("D1, worst case interleaving", () => createD1ImportStore(createSqliteD1({ interleave: true })));
runImportStoreGuards("D1", () => createD1ImportStore(createSqliteD1()));
