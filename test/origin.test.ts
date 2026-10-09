import { describe, expect, it } from "vitest";
import { africanOrigin, regionGroupFromPlace } from "../src/adapters/common.js";
import { metOriginOk, normaliseMetObject } from "../src/adapters/met.js";
import { loadProfile } from "../src/config.js";

describe("africanOrigin (owner 2026-10-08: origin decides, not travel)", () => {
  it.each([
    [["Egypt", null, null], true],
    [["probably Morocco", null, null], true],
    [[null, "Byzantine (Egypt)", null], true],
    [[null, "Coptic (Egypt)", null], true],
    [[null, "North African (Carthage)", null], true],
    [["Byzantine Egypt", "Coptic", null], true],
    [[null, "Ethiopian", null], true],
    [["Egypt or Syria (?)", null, null], false],
    [[null, "Egyptian or Levantine", null], false],
    [[null, "Egyptian or Cypriot", null], false],
    [["Iran", "Sasanian", null], false],
    [[null, null, null], false],
  ] as const)("%j -> %s", (fields, expected) => {
    expect(africanOrigin(...fields)).toBe(expected);
  });

  it("an Egyptian-made piece in Greek and Roman Art passes; a Greek vase there does not", () => {
    expect(metOriginOk({ objectID: 1, department: "Greek and Roman Art", culture: "Egyptian, Ptolemaic" })).toBe(true);
    expect(metOriginOk({ objectID: 2, department: "Greek and Roman Art", culture: "Greek, Attic", country: "Greece" })).toBe(false);
    expect(metOriginOk({ objectID: 3, department: "Egyptian Art" })).toBe(true);
  });

  it("regional grouping covers Coptic and Carthage wording", () => {
    expect(regionGroupFromPlace("Coptic")).toBe("egypt");
    expect(regionGroupFromPlace("Old Cairo")).toBe("egypt");
    expect(regionGroupFromPlace("Fostat")).toBe("egypt");
    expect(regionGroupFromPlace("North African (Carthage)")).toBe("north-africa");
  });

  it("a curated depiction (Nimrud ivory) takes the configured region group, not a guess from its Assyrian record", () => {
    const o = { objectID: 325089, department: "Ancient West Asian Art", culture: "Assyrian", region: "Mesopotamia", primaryImageSmall: "https://x/y.jpg", isPublicDomain: true };
    expect(normaliseMetObject(o, loadProfile(), false).regionGroup).toBe("sub-saharan");
    expect(normaliseMetObject(o, loadProfile(), false, "unspecified-africa").regionGroup).toBe("unspecified-africa");
  });

  it("a place given only in `region` (Near Eastern records filed under Egypt) still sets the region group", () => {
    const o = { objectID: 326618, department: "Ancient West Asian Art", culture: "Sasanian", region: "Egypt", primaryImageSmall: "https://x/y.jpg", isPublicDomain: true };
    expect(normaliseMetObject(o, loadProfile(), false).regionGroup).toBe("egypt");
    expect(normaliseMetObject({ ...o, region: "Egypt (?)", culture: undefined }, loadProfile(), false).regionGroup).toBe("egypt");
  });
});
