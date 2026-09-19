/// <reference types="vitest/config" />

import { type UserConfig, defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import devServer from "@hono/vite-dev-server";
type Config = Required<UserConfig>;

/**
 * Directories to ignore for any file-watching features.
 */
const ignoredDir = ["node_modules", "dist", "coverage", ".git", "dist-ts"].map(
    (dir) => `**/${dir}/**`
);

/**
 * Import aliases.
 * Should be exactly matched in tsconfig.base.json's "paths" field for type safety.
 */
const resolve: Config["resolve"] = {
    alias: {
        "@": fileURLToPath(new URL("src", import.meta.url)),
    },
    external: [],
};

const testConfig: Config["test"] = {
    coverage: {
        enabled: true,
        include: ["src/**/*.ts"],
        provider: "v8",
        reportOnFailure: true,
        reporter: ["text", "json-summary", "html"],
    },
    environment: "node",
    exclude: ignoredDir,
    globals: true,
    include: ["tests/**/*.test.ts"],

    setupFiles: "./tests/setup.ts",
    silent: "passed-only",
    env: {
        VITEST: "true",
    },
};

const buildConfig: Config["build"] = {
    ssr: fileURLToPath(new URL("src/index.ts", import.meta.url)),
    outDir: "dist",
    sourcemap: true,
    rolldownOptions: {
        // Disable code splitting
        output: {
            codeSplitting: false,
        },
    },
};

export default defineConfig(() => {
    return {
        plugins: [devServer()],
        server: {
            watch: {
                ignored: ignoredDir,
            },
        },
        build: buildConfig,
        clearScreen: false,
        resolve,
        test: testConfig,
    } satisfies UserConfig;
});
