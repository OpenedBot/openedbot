import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../src/lib/i18n";
import { OnboardingLogoutButton } from "../../src/screens/onboarding/components/onboarding-logout-button";
import { saveCloudSession } from "../../src/lib/session/cloud-session";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { cleanup(); for (const spy of spies.splice(0)) spy.mockRestore(); });
function mount(inline: boolean, pending = false) {
  window.localStorage.setItem("openedbot:locale", "en");
  saveCloudSession({organizationId:"",userId:"account-user",csrfToken:"csrf"});
  const requests: Array<{path:string;method:string}> = [];
  let closing = pending;
  spies.push(spyOn(globalThis,"fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    requests.push({path,method});
    if (path === "/api/auth/me") return Response.json({user:{id:"account-user",email:"owner@example.test",displayName:null},role:"member",features:{}});
    if (path === "/api/account/deletion" && method === "GET") return Response.json({
      eligible:true,blocker:null,graceDays:30,organizations:[],
      deletion:closing ? {reason:"account_deleted",requestedAt:"2026-01-01T00:00:00Z",purgeAfter:"2026-02-01T00:00:00Z",inProgress:false} : null,
    });
    if (path === "/api/account/deletion/cancel" && method === "POST") { closing = false; return Response.json({cancelled:true,deletion:null}); }
    if (path === "/api/account/security") return Response.json({
      method:{email:"owner@example.test",password:true,google:false},mustChangePassword:false,
      sessions:[{id:"session-own",kind:"web",current:true,createdAt:"2026-01-01T00:00:00Z",lastSeenAt:"2026-01-01T00:00:00Z",expiresAt:"2027-01-01T00:00:00Z",revokedAt:null,revokedReason:null,userAgent:"Mozilla/5.0",ip:null}],
    });
    throw new Error(`Unexpected account-only request: ${method} ${path}`);
  }, { preconnect: globalThis.fetch.preconnect })));
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><I18nProvider><OnboardingLogoutButton inline={inline} /></I18nProvider></QueryClientProvider>);
  return requests;
}
for (const inline of [false,true]) {
  test(`orgless onboarding opens closure and own sessions without a tenant (inline=${inline})`, async () => {
    const requests = mount(inline);
    const button = await screen.findByRole("button",{name:"My account"});
    expect(requests.every(({path}) => path === "/api/auth/me")).toBe(true);
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog",{name:"My account"});
    await within(dialog).findByText("No workspaces to delete or leave.");
    expect(within(dialog).getByText(/Deletion may begin 30 days after/)).toBeTruthy();
    fireEvent.mouseDown(within(dialog).getByRole("tab",{name:"Devices"}),{button:0,ctrlKey:false});
    await within(dialog).findByText("owner@example.test");
    expect(within(dialog).queryByRole("tab",{name:"Password"})).toBeNull();
    expect(requests.some(({path}) => path === "/api/account/security")).toBe(true);
    expect(requests.every(({path,method}) => method === "GET" && ["/api/auth/me","/api/account/deletion","/api/account/security"].includes(path))).toBe(true);
  });
}
test("orgless onboarding cancels a pending closure without creating a workspace", async () => {
  const requests = mount(true,true);
  fireEvent.click(await screen.findByRole("button",{name:"My account"}));
  const dialog = await screen.findByRole("dialog",{name:"My account"});
  fireEvent.click(await within(dialog).findByRole("button",{name:"Cancel account closure"}));
  await within(dialog).findByRole("button",{name:"Schedule account closure"});
  await waitFor(() => expect(requests.filter(({method}) => method === "POST")).toEqual([{path:"/api/account/deletion/cancel",method:"POST"}]));
  expect(requests.every(({path}) => ["/api/auth/me","/api/account/deletion","/api/account/deletion/cancel"].includes(path))).toBe(true);
});
