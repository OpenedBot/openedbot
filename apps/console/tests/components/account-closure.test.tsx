import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../src/lib/i18n";
import { AccountClosureSection } from "../../src/screens/settings/account/closure";
import { api, queryKeys } from "../../src/lib/api";
import type { AccountDeletionStateDto } from "@openedbot/contracts-api";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { cleanup(); for (const spy of spies.splice(0)) spy.mockRestore(); });
function mount(data: AccountDeletionStateDto) {
  window.localStorage.setItem("openedbot:locale", "en");
  const read = spyOn(api,"accountDeletion").mockResolvedValue(data);
  spies.push(read);
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><I18nProvider><AccountClosureSection /></I18nProvider></QueryClientProvider>);
  return { client, read };
}
test("shows workspace names and distinct consequences before exact confirmation", async () => {
  const schedule = spyOn(api,"scheduleAccountDeletion").mockResolvedValue({scheduled:true,deletion:{reason:"account_deleted",requestedAt:"2026-01-01",purgeAfter:"2026-02-01",inProgress:false}});
  spies.push(schedule);
  mount({eligible:true,blocker:null,deletion:null,graceDays:30,organizations:[{id:"solo",name:"Personal research",action:"delete"},{id:"shared",name:"Team archive",action:"leave"}]});
  await screen.findByText("Personal research");
  expect(screen.getByText("Team archive")).toBeTruthy();
  expect(screen.getByText(/Deletion may begin 30 days after/)).toBeTruthy();
  const submit = screen.getByRole("button",{name:"Schedule account closure"});
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText(/Type DELETE/),{target:{value:"DELETE"}});
  fireEvent.click(submit);
  await waitFor(() => expect(schedule).toHaveBeenCalledWith("DELETE",["solo"],30));
});
test("a last-owner blocker prevents scheduling and explains transfer", async () => {
  mount({eligible:false,blocker:"transfer_required",deletion:null,organizations:[{id:"shared",name:"Team archive",action:"leave"}]});
  await screen.findByText(/Appoint another owner/);
  expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(true);
});

test("zero days explicitly warns that deletion may begin immediately", async () => {
  mount({eligible:true,blocker:null,deletion:null,graceDays:0,organizations:[]});
  await screen.findByText(/No grace period: deletion may begin immediately/);
  fireEvent.change(screen.getByLabelText(/Type DELETE/),{target:{value:"DELETE"}});
  expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(false);
});
test("an older API without the delay cannot schedule deletion, even by submitting the form", async () => {
  const schedule = spyOn(api,"scheduleAccountDeletion");
  spies.push(schedule);
  mount({eligible:true,blocker:null,deletion:null,organizations:[]});
  await screen.findByText(/The server did not provide the deletion delay/);
  const confirmation = screen.getByLabelText(/Type DELETE/);
  expect(confirmation.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(true);
  fireEvent.submit(confirmation.closest("form")!);
  expect(schedule).not.toHaveBeenCalled();
});

for (const change of ["workspace", "delay"] as const) {
  test(`a refetched ${change} plan clears DELETE synchronously and requires confirmation again`, async () => {
    const schedule = spyOn(api,"scheduleAccountDeletion").mockResolvedValue({scheduled:true,deletion:{reason:"account_deleted",requestedAt:"2026-01-01",purgeAfter:"2026-02-01",inProgress:false}});
    spies.push(schedule);
    const original: AccountDeletionStateDto = {eligible:true,blocker:null,deletion:null,graceDays:30,organizations:[{id:"solo",name:"Personal research",action:"delete"}]};
    const changed: AccountDeletionStateDto = change === "delay" ? {...original,graceDays:0}
      : {...original,organizations:[...original.organizations,{id:"added",name:"New workspace",action:"delete"}]};
    const { client, read } = mount(original);
    await screen.findByText("Personal research");
    fireEvent.change(screen.getByLabelText(/Type DELETE/),{target:{value:"DELETE"}});
    expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(false);
    read.mockResolvedValue(changed);
    await act(async () => { await client.refetchQueries({queryKey:queryKeys.accountDeletion}); });
    await waitFor(() => expect((screen.getByLabelText(/Type DELETE/) as HTMLInputElement).value).toBe(""));
    expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByLabelText(/Type DELETE/).closest("form")!);
    expect(schedule).not.toHaveBeenCalled();
    // Reverting to the old plan must not resurrect its old confirmation either.
    read.mockResolvedValue(original);
    await act(async () => { await client.refetchQueries({queryKey:queryKeys.accountDeletion}); });
    await waitFor(() => expect((screen.getByLabelText(/Type DELETE/) as HTMLInputElement).value).toBe(""));
    expect(screen.getByRole("button",{name:"Schedule account closure"}).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type DELETE/),{target:{value:"DELETE"}});
    fireEvent.click(screen.getByRole("button",{name:"Schedule account closure"}));
    await waitFor(() => expect(schedule).toHaveBeenCalledWith("DELETE",["solo"],30));
  });
}
