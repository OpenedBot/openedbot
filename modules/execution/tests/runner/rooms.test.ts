import { describe, expect, test } from "bun:test";
import type { LoadedAttachment } from "@openedbot/conversation/domain/attachments";
import { roomDigest, roomImages } from "../../src/application/runner/rooms";

const photo: LoadedAttachment = {
  name: "desk agent.png",
  contentType: "image/png",
  kind: "image",
  data: new Uint8Array([9]),
};

describe("roomDigest", () => {
  test("la photo du message opérateur arrive dans l'entrée du membre", () => {
    const digest = roomDigest(
      [{
        role: "user",
        content: [
          { type: "text", text: "decrit moi la photo" },
          { type: "attachment", id: "a", name: "desk agent.png", contentType: "image/png", kind: "image", bytes: 1 },
        ],
        authorBotId: null,
        authorName: null,
        authorSlug: null,
      }],
      "bot-1",
      { username: "elodie" },
      new Map([["a", photo]]),
    );
    expect(digest).toContain("decrit moi la photo");
    expect(digest).toContain('image attached: "desk agent.png" (image/png)');
    expect(digest).not.toContain("base64");
  });

  test("la photo du message opérateur part en part image_url, pas celle du membre lui-même", () => {
    const chip = (id: string) => ({ type: "attachment", id, name: "desk agent.png", contentType: "image/png", kind: "image", bytes: 1 });
    const images = roomImages(
      [
        { role: "user", content: [chip("a")], authorBotId: null, authorName: null, authorSlug: null },
        { role: "assistant", content: [chip("b")], authorBotId: "bot-1", authorName: "Moi", authorSlug: "moi" },
      ],
      "bot-1",
      new Map([["a", photo], ["b", photo]]),
    );
    expect(images).toEqual([{ name: "desk agent.png", dataUrl: "data:image/png;base64,CQ==" }]);
  });
});
