import { describe, expect, it } from "vitest";
import { normaliseMiaRecord } from "../src/adapters/mia.js";
import { loadDenylist, loadProfile } from "../src/config.js";
import { denyReason } from "../src/denylist.js";
import type { PreparedImage } from "../src/image.js";
import { isPhotograph, photographPeopleReason } from "../src/people.js";
import { readFileSync } from "node:fs";

const deny = loadDenylist();
const profile = loadProfile();
const base = normaliseMiaRecord(JSON.parse(readFileSync(new URL("./fixtures/mia/sande-mask-1937.json", import.meta.url), "utf8")), profile);
const img: PreparedImage = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", width: 10, height: 10, resized: false, originalBytes: 3 };

const sees = (...d: Array<[string, number]>) => async () => d.map(([label, score]) => ({ label, score }));

describe("photographs", () => {
  it("recognises a photograph from the museum's type or medium wording, not from the description", () => {
    expect(isPhotograph({ ...base, objectType: "Photograph", medium: "Gelatin silver print" }, deny)).toBe(true);
    expect(isPhotograph({ ...base, objectType: "Fotografie" }, deny)).toBe(true);
    expect(isPhotograph({ ...base, objectType: "Portrait", medium: "Albumen silver print" }, deny)).toBe(true);
    expect(isPhotograph(base, deny)).toBe(false);
    expect(isPhotograph({ ...base, description: "Photographed in 1937 as a gelatin silver print." }, deny)).toBe(false);
  });

  it("is not blocked outright by the denylist: the image decides", () => {
    expect(denyReason({ ...base, objectType: "Photograph", medium: "Gelatin silver print" }, deny)).toBeNull();
  });

  it("allows a photograph only when no person is detected", async () => {
    expect(await photographPeopleReason(img, sees())).toBeNull();
    expect(await photographPeopleReason(img, sees(["umbrella", 0.9], ["person", 0.1]))).toBeNull();
    expect(await photographPeopleReason(img, sees(["umbrella", 0.52], ["person", 1]))).toMatch(/real person/);
    expect(await photographPeopleReason(img, sees(["person", 0.3]))).toMatch(/real person/);
  });

  it("fails closed: a detector that cannot load or run keeps the photograph out", async () => {
    expect(await photographPeopleReason(img, async () => { throw new Error("offline"); })).toMatch(/not checked.*offline/);
  });
});
