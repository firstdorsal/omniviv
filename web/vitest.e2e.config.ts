import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            environment: "node",
            include: ["src/**/*.e2e.test.ts"],
            testTimeout: 30000,
        }
    })
);
