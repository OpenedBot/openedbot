import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertEmailDeliverable } from "../src/application/email-deliverability";
import type { EmailDomainResolver } from "../src/application/email-domain-check";

const deliverable: EmailDomainResolver = async () => "deliverable";
const unknown: EmailDomainResolver = async () => "unknown_domain";
const broken: EmailDomainResolver = async () => "unverified";

async function refusal(email: string, checkDomain: EmailDomainResolver): Promise<HttpError | null> {
  try {
    await assertEmailDeliverable(email, checkDomain, "member_invitation");
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
}

describe("invitation address deliverability", () => {
  test("a well-formed address on a domain that refuses mail is refused with EMAIL_DOMAIN_UNKNOWN", async () => {
    // `gmail.co` is well formed and publishes a Null MX: the resolver answers `unknown_domain`.
    const error = await refusal("dupont@gmail.co", unknown);
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("EMAIL_DOMAIN_UNKNOWN");
  });

  test("a disposable mailbox is refused before the DNS is asked", async () => {
    let asked = false;
    const spy: EmailDomainResolver = async () => { asked = true; return "deliverable"; };
    const error = await refusal("camille@mailinator.com", spy);
    expect(error?.code).toBe("EMAIL_DISPOSABLE");
    expect(asked).toBe(false);
  });

  test("a deliverable domain passes", async () => {
    expect(await refusal("camille.lefevre@example.com", deliverable)).toBeNull();
  });

  test("a resolver outage lets the address through", async () => {
    expect(await refusal("camille.lefevre@example.com", broken)).toBeNull();
  });
});
