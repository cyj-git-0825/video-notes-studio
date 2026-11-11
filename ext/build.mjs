// 打包插件：src/ → ../extension/dist/，static/ → ../extension/。生成的 extension/ 目录就是在 Chrome 里“加载已解压的扩展程序”的那个。
import { cpSync, mkdirSync, rmSync } from "node:fs";
import * as esbuild from "esbuild";

const OUT = "../extension";
const watch = process.argv.includes("--watch");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/dist`, { recursive: true });
cpSync("static", OUT, { recursive: true });

const options = {
  entryPoints: { bg: "src/bg.js", app: "src/app.js", options: "src/options.js", content: "src/content.js" },
  outdir: `${OUT}/dist`,
  bundle: true,
  format: "iife",
  target: "chrome120",
  charset: "utf8",
  logLevel: "info",
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
