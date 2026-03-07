import { createHash } from "node:crypto";

export function nodeId(filePath: string, name: string, kind: string): string {
  return createHash("sha256")
    .update(filePath + ":" + name + ":" + kind)
    .digest("hex");
}
