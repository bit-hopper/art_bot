import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/config.js";
import { louvreAfricanPlace, normaliseLouvreRecord, type LouvreRecord } from "../src/adapters/louvre.js";

describe("louvreAfricanPlace (origin rule, owner 2026-10-09)", () => {
  it.each([
    ["Cuicul = Djemila", "north-africa"],
    ["Carthage", "north-africa"],
    ["Cyrène", "north-africa"],
    ["Alexandrie", "egypt"],
    ["Égypte", "egypt"],
    ["Fayoum", "egypt"],
    ["Le Caire", "egypt"],
    ["Tunisie (?)", "north-africa"],
    ["Éthiopie", "sub-saharan"],
    ["Athènes", null],
    ["Liban (?) ; Syrie (?)", null],
    ["Égypte ; Grèce", null],
    ["Italie méridionale (?)", null],
    ["Suse", null],
    ["", null],
    [undefined, null],
  ] as const)("%s -> %s", (place, expected) => {
    expect(louvreAfricanPlace(place)).toBe(expected);
  });

  it("a Roman-era object made in Algeria gets its own region group and country; Egyptian Antiquities stay egypt", () => {
    const roman: LouvreRecord = { arkId: "cl010275998", collection: "Département des Antiquités grecques, étrusques et romaines", placeOfCreation: "Cuicul = Djemila", title: "stèle funéraire" };
    const a = normaliseLouvreRecord(roman, loadProfile());
    expect(a).toMatchObject({ regionGroup: "north-africa", country: "Cuicul" });
    const egypt: LouvreRecord = { arkId: "cl010000010", collection: "Département des Antiquités égyptiennes", title: "statuette" };
    expect(normaliseLouvreRecord(egypt, loadProfile())).toMatchObject({ regionGroup: "egypt", country: "Egypt" });
  });
});
