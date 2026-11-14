import { withDisposablePostgres } from "./disposable-postgres";
import { unsettledRunCount } from "../e2e/bot/kit/acceptance";

const id = (n: number) => `90230000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

await withDisposablePostgres("openedbot023_e2e_guard", async ({ owner, connect }) => {
  const organization = id(1), otherOrganization = id(2);
  for (const [index, org] of [organization, otherOrganization].entries()) {
    await owner`insert into organizations (id,slug,name) values (${org}, ${`e2e-guard-${index}`}, 'E2E guard')`;
    await owner`insert into sections (id,organization_id,name,position) values (${id(10 + index)},${org},'Bots',0)`;
  }
  for (let index = 0; index < 3; index++) {
    const org = index === 2 ? otherOrganization : organization;
    const section = index === 2 ? id(11) : id(10);
    await owner`insert into bots (id,organization_id,section_id,name,slug,position)
      values (${id(20 + index)},${org},${section},'Fixture',${`fixture-${index}`},${index})`;
    await owner`insert into threads (id,organization_id,bot_id,title,hermes_session_id,is_default)
      values (${id(30 + index)},${org},${id(20 + index)},'Fixture',${`guard-${index}`},true)`;
    await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,step_kind,step_index)
      values (${id(40 + index)},${org},${id(30 + index)},${id(20 + index)},'Fixture','awaiting_approval','root',0)`;
  }
  const worker = await connect("openedbot_worker");
  assert(await unsettledRunCount(worker, organization, id(20), false) === 2, "The default guard must include other tenants.");
  assert(await unsettledRunCount(worker, organization, id(20), true) === 1, "Dedicated-lab reservation must still block another bot on the selected runtime.");
  assert(await unsettledRunCount(worker, organization, null, true) === 2, "Idle restart must include owned work too.");
  await owner`update runs set status='cancelled' where id=${id(41)}`;
  assert(await unsettledRunCount(worker, organization, id(20), true) === 0, "An unrelated tenant must not impersonate work on an explicitly reserved runtime.");
  assert(await unsettledRunCount(worker, organization, id(20), false) === 1, "Without a reservation the other tenant must still block restart.");
  await owner`update runs set status='unknown' where id=${id(41)}`;
  assert(await unsettledRunCount(worker, organization, id(20), true) === 1, "An ambiguous run on the selected runtime must always block restart.");
});
console.info("E2E runtime guard: conservative default, explicit reservation, same-runtime foreign/unknown work and idle checks passed.");
