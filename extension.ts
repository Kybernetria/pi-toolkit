import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProtocolNamespace,
  ensureProtocolFabric,
  parseProtocolManifest,
  registerProtocolManifest,
} from "@kybernetria/pi-protocol";
import { createHandlers } from "./src/handlers.ts";

const manifest = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
);
const protocol = createProtocolNamespace(manifest);

export default function piToolkitExtension(_pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  fabric.unregister(protocol.nodeId);
  registerProtocolManifest(fabric, { manifest, handlers: createHandlers() });
}
