import { createMemoryImportStore } from "../src/import/store";
import { runImportStoreGuards, runImportStoreSuite } from "./importStore.suite";

runImportStoreSuite("memory", createMemoryImportStore);
runImportStoreGuards("memory", createMemoryImportStore);
