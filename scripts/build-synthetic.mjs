import { URL } from "node:url";
import { buildStaticDashboard } from "./build-demo.mjs";

await buildStaticDashboard("demo", new URL("../dist/demo/", import.meta.url));
