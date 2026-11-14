import { afterEach, describe, expect, test } from "bun:test";
import { dropLoginBoot, flyLoginBoot, hasLoginBoot, LOGIN_BOOT_ID } from "../../../src/screens/auth/login-boot";

/** The mascot as `index.html` draws it on `/login`. */
function drawBoot() {
  const boot = document.createElement("div");
  boot.id = LOGIN_BOOT_ID;
  boot.innerHTML = '<div class="mascot"><img src="/brand/openedbot-icon.webp" alt=""></div>';
  document.body.append(boot);
  document.documentElement.setAttribute("data-openedbot-boot-login", "");
  return boot;
}

afterEach(() => dropLoginBoot());

describe("the /login boot mascot", () => {
  test("is there only with its element and its attribute, and drops cleanly", () => {
    expect(hasLoginBoot()).toBe(false);
    drawBoot();
    expect(hasLoginBoot()).toBe(true);
    dropLoginBoot();
    expect(hasLoginBoot()).toBe(false);
    expect(document.getElementById(LOGIN_BOOT_ID)).toBeNull();
    expect(document.documentElement.hasAttribute("data-openedbot-boot-login")).toBe(false);
  });

  test("with nothing to fly to, no flight: the mascot goes and the caller shows the logo", () => {
    drawBoot();
    let landed = 0;
    expect(flyLoginBoot(document.createElement("span"), () => landed++)).toBeNull();
    expect(landed).toBe(0);
    expect(document.getElementById(LOGIN_BOOT_ID)).toBeNull();
  });

  test("without a mascot, no flight either", () => {
    expect(flyLoginBoot(document.createElement("span"), () => {})).toBeNull();
  });
});
