import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    timeout: 60000,
    use: {
        baseURL: "http://localhost:5174",
        headless: true,
        // Use system Chrome on NixOS (Playwright's bundled Chromium lacks shared libs)
        channel: "chrome",
    },
    projects: [
        { name: "chromium", use: { browserName: "chromium" } },
    ],
});
