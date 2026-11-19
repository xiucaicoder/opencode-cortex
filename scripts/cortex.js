#!/usr/bin/env bun
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2), process.cwd())
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    console.error("执行失败:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
