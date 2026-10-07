import { readFileSync } from "node:fs";

import worker from "../worker/index.js";

const corpus = JSON.parse(readFileSync(new URL("../frontend/data/yc-public-companies.json", import.meta.url), "utf8"));

function routeRequest(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("__path");
  if (!path) return request;
  url.pathname = `/${path.replace(/^\/+/, "")}`;
  url.searchParams.delete("__path");
  return new Request(url, request);
}

export default {
  fetch(request) {
    return worker.fetch(routeRequest(request), { ...process.env, CORPUS: corpus });
  },
};
