import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import { createHandlers } from "./src/handlers.ts";

const definition = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
  { allowLegacyV02: false },
);

export default function piToolkitExtension(pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  const registration = fabric.install(definition, { handlers: createHandlers() }, {
    packageId: "pi-toolkit",
    packageVersion: "0.1.0",
    sourcePath: fileURLToPath(new URL(".", import.meta.url)),
  });
  pi.on("session_shutdown", async () => { await registration.dispose(); });
}
