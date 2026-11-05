import { expect, test } from "bun:test";
import { renderRuntimeLinkUnit } from "../runtime-link-service";

test("gateway service is independent, has bounded restart and allows maximum drain", () => {
  const unit = renderRuntimeLinkUnit("/srv/openedbot app", "/opt/bun/bin/bun");
  expect(unit).toContain('WorkingDirectory=/srv/openedbot app');
  expect(unit).toContain('ExecStart=/bin/bash "/srv/openedbot app/scripts/runtime-link-launch.sh" "/opt/bun/bin/bun"');
  expect(unit).toContain("TimeoutStopSec=330");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).not.toMatch(/--watch|PartOf=|BindsTo=|npm/);
});
test("unit paths cannot inject directives or systemd substitutions", () => {
  expect(() => renderRuntimeLinkUnit("/srv/x\nExecStart=bad", "/bin/bun")).toThrow();
  expect(() => renderRuntimeLinkUnit("relative", "/bin/bun")).toThrow();
  expect(renderRuntimeLinkUnit("/srv/openedbot%$", "/bin/bun")).toContain('/srv/openedbot%%$$');
});
