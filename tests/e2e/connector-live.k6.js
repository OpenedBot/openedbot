// Opt-in deployed connector smoke: loopback API -> existing VPS /health only.
// Pass OPENEDBOT_K6_RUNTIME_ID and OPENEDBOT_K6_INTERNAL_TOKEN in the process environment.
// No model calls, credentials changes, lifecycle actions or fault injection.
import http from "k6/http";
import { check, sleep } from "k6";

const runtimeId = __ENV.OPENEDBOT_K6_RUNTIME_ID;
if (!/^[a-f0-9-]{36}$/i.test(runtimeId || "") || !__ENV.OPENEDBOT_K6_INTERNAL_TOKEN) {
  throw new Error("OPENEDBOT_K6_RUNTIME_ID and OPENEDBOT_K6_INTERNAL_TOKEN are required");
}
const apiUrl = (__ENV.OPENEDBOT_K6_API_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
if (!/^https:\/\/[^/?#@]+$/i.test(apiUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(apiUrl)) {
  throw new Error("OPENEDBOT_K6_API_URL must be an HTTPS origin or HTTP loopback origin");
}
const url = `${apiUrl}/internal/runtime-links/${runtimeId}/proxy/health`;

export const options = {
  scenarios: {
    health: { executor: "constant-vus", vus: 8, duration: "10s", gracefulStop: "3s" },
  },
  thresholds: { http_req_failed: ["rate==0"], checks: ["rate==1"] },
};

export default function () {
  const response = http.get(url, {
    headers: { Authorization: `Bearer ${__ENV.OPENEDBOT_K6_INTERNAL_TOKEN}` },
    timeout: "3s",
    redirects: 0,
    tags: { name: "deployed connector health" },
  });
  check(response, { "VPS health returns 200": (response) => response.status === 200 });
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    [__ENV.OPENEDBOT_K6_SUMMARY || "/tmp/ohb-live-connector-k6-summary.json"]: JSON.stringify(data, null, 2),
    stdout: JSON.stringify({
      requests: data.metrics.http_reqs.values.count,
      failedRate: data.metrics.http_req_failed.values.rate,
      checks: data.metrics.checks.values,
      durationMs: data.metrics.http_req_duration.values,
    }) + "\n",
  };
}
