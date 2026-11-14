import { describe, expect, test } from "bun:test";
import { readAttachments } from "../src/routes/conversation/conversation-input";
import { attachmentPayload, rejectAttachments } from "@openedbot/conversation/domain/attachments";
import { HttpError } from "../src/interfaces/http/http-error";

const image = (content: unknown, contentType = "image/png") => [{ name: "proof.png", contentType, kind: "image", content }];

describe("attachment input is validated before ingress or blob writes", () => {
  test("rejects malformed nested content and invalid data URIs with the public 400 error", () => {
    for (const input of [null, {}, [null], [[]],
      image([null]), image([{}]), image([{ type: "image" }]), image([{ type: "image", image: 4 }]),
      image([{ type: "text", text: "not pixels" }]), image([{ type: "image", image: "not-a-data-uri" }]),
      image([{ type: "image", image: "https://example.com/image.png" }]),
      image([{ type: "image", image: "data:text/html;base64,WA==" }]),
      image([{ type: "image", image: "data:image/jpeg;base64,WA==" }]),
      image([{ type: "image", image: "data:image/png;base64,A" }]),
      image([{ type: "image", image: "data:image/png;base64,AA=" }]),
      image([{ type: "image", image: "data:image/png;base64,AA==!" }]),
      image([{ type: "image", image: "data:image/png;base64,AA==" }, { type: "image", image: "data:image/png;base64,AA==" }]),
      [{ name: "file.txt", kind: "document", contentType: "text/plain", content: [{ type: "text", text: null }] }],
    ]) {
      let error: unknown;
      try { readAttachments(input); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 400, code: "ATTACHMENTS_INVALID" });
    }
  });

  test("accepts adapter text and padded or unpadded base64 images that safely decode", () => {
    expect(readAttachments(undefined)).toEqual([]);
    for (const payload of ["WA==", "WA", "WVo=", "WVo", "WFl6"]) {
      const [file] = readAttachments(image([{ type: "image", image: `data:image/png;base64,${payload}` }]));
      expect(file).toBeDefined();
      expect(() => attachmentPayload(file!)).not.toThrow();
      expect(rejectAttachments([file!])).toBeNull();
    }
    const [file] = readAttachments([{ name: "file.txt", kind: "document", contentType: "text/plain", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }]);
    expect(new TextDecoder().decode(attachmentPayload(file!).data)).toBe("first\nsecond");
  });
});
