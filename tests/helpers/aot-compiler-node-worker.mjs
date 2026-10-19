// Node worker_threads stand-in for the browser module Worker that runs
// src/aot-compiler-worker.js: same handler, a parentPort shaped like `self`.
import { parentPort } from "node:worker_threads";
import { installAotCompilerWorker } from "../../src/aot-compiler-worker.js";

installAotCompilerWorker({
  addEventListener(type, listener) {
    if (type === "message") parentPort.on("message", (data) => listener({ data }));
  },
  postMessage(message) {
    parentPort.postMessage(message);
  }
});
