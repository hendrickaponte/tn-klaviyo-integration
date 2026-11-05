import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "esnext",
  clean: true,
  minify: true,
  bundle: true,
  sourcemap: false,
  splitting: false,
  skipNodeModulesBundle: false,
  outExtension: () => ({ js: ".min.js" }),
});
