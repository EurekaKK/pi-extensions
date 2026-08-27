import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { MEMORY_STORE_DIRECTORY_NAME, MEMORY_STORE_FILE_NAME } from "./constants.js";

/** Memory Store directory inside the Working Directory's Pi configuration area. */
export function getMemoryStoreDirectory(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, MEMORY_STORE_DIRECTORY_NAME);
}

/** Canonical Store document path for the exact Working Directory. */
export function getMemoryStorePath(cwd: string): string {
	return join(getMemoryStoreDirectory(cwd), MEMORY_STORE_FILE_NAME);
}
