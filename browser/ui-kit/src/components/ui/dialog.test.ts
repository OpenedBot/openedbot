import { describe, expect, test } from "bun:test";
import { lockBodyScroll } from "./dialog";

describe("le verrou de défilement des boîtes", () => {
  test("fermer la boîte du dessous d'abord garde la page verrouillée jusqu'à la dernière", () => {
    const body = { style: { overflow: "auto" } };
    const releaseBottom = lockBodyScroll(body);
    const releaseTop = lockBodyScroll(body);
    expect(body.style.overflow).toBe("hidden");
    releaseBottom();
    expect(body.style.overflow).toBe("hidden");
    releaseTop();
    expect(body.style.overflow).toBe("auto");
  });

  test("une double libération ne rend pas le défilement à une autre boîte encore ouverte", () => {
    const body = { style: { overflow: "" } };
    const releaseFirst = lockBodyScroll(body);
    const releaseSecond = lockBodyScroll(body);
    releaseFirst();
    releaseFirst();
    expect(body.style.overflow).toBe("hidden");
    releaseSecond();
    expect(body.style.overflow).toBe("");
  });
});
