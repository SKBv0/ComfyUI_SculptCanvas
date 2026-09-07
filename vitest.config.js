import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    resolve: {
        alias: {
            "../../../scripts/api.js": fileURLToPath(new URL("./tests/helpers/comfyApi.js", import.meta.url)),
            "../../../scripts/app.js": fileURLToPath(new URL("./tests/helpers/comfyApp.js", import.meta.url))
        }
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.js"]
    }
});
