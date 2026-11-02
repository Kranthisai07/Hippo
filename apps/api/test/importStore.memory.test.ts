import { createMemoryImportStore } from "../src/import/store";
import { runImportStoreSuite } from "./importStore.suite";

runImportStoreSuite("memory", createMemoryImportStore);
