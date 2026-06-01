// SPA エントリポイント。#app に App.svelte をマウントする。
import "./app.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("mount target #app not found");
}

const app = new App({ target });

export default app;
