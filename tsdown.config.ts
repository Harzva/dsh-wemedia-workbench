import { defineConfig } from "tsdown";

const PLUGIN_ID = "dsh-wemedia-workbench";
const HOST_EXTERNALS = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-typert-protocol",
] as const;
const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-ui-layout/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
] as const;

export default defineConfig([
  {
    name: `${PLUGIN_ID}/host`,
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    name: `${PLUGIN_ID}/typert`,
    entry: { "typert.host": "src/remote/contribution.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2022",
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) =>
        CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number])
          ? undefined
          : true,
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
