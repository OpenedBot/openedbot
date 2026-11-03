import { describe, expect, test } from "bun:test";
import { composeRunInput, imageAttachment, modelTextFromContent, type LoadedAttachment } from "../src/domain/attachments";

const photo: LoadedAttachment = {
  name: "desk agent.png",
  contentType: "image/png",
  kind: "image",
  data: new Uint8Array([1, 2, 3]),
};

describe("modelTextFromContent", () => {
  test("met la photo dans le texte que le salon envoie au modèle", () => {
    const text = modelTextFromContent([
      { type: "text", text: "decrit moi la photo" },
      { type: "attachment", id: "a", name: "desk agent.png", contentType: "image/png", kind: "image", bytes: 3 },
    ], new Map([["a", photo]]));
    expect(text.startsWith("decrit moi la photo")).toBe(true);
    expect(text).toContain('image attached: "desk agent.png" (image/png)');
    expect(text).not.toContain("base64");
  });

  test("un document sans octets est dit, pas omis", () => {
    const text = modelTextFromContent([
      { type: "text", text: "lis ce fichier" },
      { type: "attachment", id: "gone", name: "notes.txt", contentType: "text/plain", kind: "document", bytes: 3 },
    ], new Map([["gone", "missing"]]));
    expect(text).toContain('[attachment "notes.txt" is no longer available]');
  });

  test("une image d'un message plus ancien est nommée comme absente de ce tour", () => {
    const text = modelTextFromContent([
      { type: "attachment", id: "old", name: "desk agent.png", contentType: "image/png", kind: "image", bytes: 3 },
    ], new Map());
    expect(text).toBe('[image "desk agent.png" from an earlier message is not included in this turn]');
  });

  test("l'entrée d'un DM garde le nom de l'image, jamais son data-URI", () => {
    const input = composeRunInput("et ça ?", [imageAttachment("a.png", "image/png", "data:image/png;base64,AAAA")]);
    expect(input).toContain('image attached: "a.png" (image/png)');
    expect(input).not.toContain("base64");
  });
});
