import { createRequire } from "node:module";

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;
const nodeRequire = createRequire(import.meta.url);

export const loadLanceDB = async (): Promise<
  typeof import("@lancedb/lancedb")
> => {
  if (!lancedbImportPromise) {
    // Use require() for CommonJS modules on Windows to avoid ESM URL scheme issues
    lancedbImportPromise = Promise.resolve(
      nodeRequire("@lancedb/lancedb") as typeof import("@lancedb/lancedb"),
    );
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(
      `mymem: failed to load LanceDB. ${String(err)}`,
      { cause: err },
    );
  }
};
