import { describe, expect, it } from "vitest";
import { africanOrigin, classifyRecord, isFlatFragment, regionGroupFromPlace, scoreFor } from "../src/adapters/common.js";
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
    [["North Africa, Aghlabid or Abbasid, 9th century", null, null], true],
    [["Greek, Ptolemaic, minted at Alexandreia (Egypt), reign of Ptolemy V Epiphanes or Ptolemy VI Philometor", null, null], true],
    [["Syria or Egypt, Mamluk Dynasty (1250–1517)", null, null], false],
    [["Byzantium, Egypt or Syria, early Byzantine period", null, null], false],
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

  it("a coffin or stela is sculpture even under a generic type; ornaments, coins and weapons are carved-cast", () => {
    const profile = loadProfile();
    expect(classifyRecord("Funerary Equipment", "Coffin of Senbi", profile)).toBe("sculpture");
    expect(classifyRecord("Architectural fragment", "Stela of Amenemhat and Yatu", profile)).toBe("sculpture");
    expect(classifyRecord("Funerary Equipment", "Book of the Dead vignette", profile)).toBe("other");
    expect(classifyRecord("Funerary Equipment", "Shawabty of Ditamenpaankh", profile)).toBe("other");
    expect(classifyRecord("Religious/Ritual Object", "Pair of Staffs (Edan)", profile)).toBe("other-carved-cast");
    expect(classifyRecord("Furniture and woodwork", "Prestige stool (Kuo fo)", profile)).toBe("other-carved-cast");
    expect(classifyRecord("Tapper", "Ifa Divination Tapper", profile)).toBe("other-carved-cast");
    expect(classifyRecord("Neckrest", "Neckrest", profile)).toBe("other-carved-cast");
    for (const type of ["Coins", "Münze", "Dagger", "Sword", "Spear", "Shield", "Helmet", "Arms and Armor", "Dolch", "Speer"])
      expect(classifyRecord(type, "x", profile)).toBe("other-carved-cast");
    for (const [type, title] of [["Jewelry", "Finger Ring of Shoshenq I"], ["Amulets", "Son of Horus Amulet"], ["Scarabs", "Scarab"], ["Costume and Accessories", "Ring: Figure of Seated Cat"],
      ["Costume and Accessories", "Amulet of the God Bes"], ["Costume and Accessories", "String of Beads"], ["Armreif", "Armreif"], ["Halsschmuck", "x"]] as const)
      expect(classifyRecord(type, title, profile)).toBe("other-carved-cast");
    expect(classifyRecord("Costume and Accessories", "Curling Iron or Hair Crimper", profile)).toBe("other");
    expect(classifyRecord("Textile", "Fragment of a Clavus", profile)).toBe("other");
  });

  it("textile and papyrus fragments score lower; ceramic and wooden fragments do not", () => {
    expect(isFlatFragment("Textile", "Fragment of a Clavus")).toBe(true);
    expect(isFlatFragment("Fragment (Textilien)", null)).toBe(true);
    expect(isFlatFragment("Papyrus", "Papyrus fragment")).toBe(true);
    expect(isFlatFragment("Fragment (Schale)", "Fragment (Schale)")).toBe(false);
    expect(isFlatFragment("Fragment (Möbel)", null)).toBe(false);
    expect(isFlatFragment("Textile", "Roundel from a Tunic")).toBe(false);
    expect(scoreFor(10, { fragment: true })).toBeCloseTo(3);
    expect(scoreFor(40)).toBe(40);
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
