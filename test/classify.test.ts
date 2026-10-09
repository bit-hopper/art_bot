import { describe, expect, it } from "vitest";
import { classify } from "../src/classify.js";
import { loadProfile } from "../src/config.js";
import type { ObjectClass } from "../src/types.js";

const profile = loadProfile();

// Table-driven cases from the 2026-10-08 SMB sample (spec 11.2): real object types, with the traps found.
const cases: Array<[string, ObjectClass]> = [
  ["Maske", "mask"],
  ["Maske (Mask)", "mask"],
  ["Kopfaufsatzmaske", "mask"],
  ["Mumienmaske (Grabausstattung / Mumienhülle)", "mask"],
  ["Gürtelmaske (Hip mask)", "mask"],
  ["Maskengewand", "other"],                     // costume, not a mask
  ["Klapper für Maskentanz", "other"],           // rattle
  ["Statue (Rundbild)", "sculpture"],
  ["Statuette (Rundbild)", "sculpture"],
  ["Relief (Stele)", "sculpture"],
  ["Reliquiarfigur (byeri)", "sculpture"],
  ["Menschliche Skulptur", "sculpture"],
  ["Kopf", "sculpture"],
  ["Tabakpfeifenkopf", "other-carved-cast"],     // pipe bowl, not a carved head
  ["Pfeifenkopf", "other-carved-cast"],
  ["Kopfstütze", "other-carved-cast"],           // headrest
  ["Kopfschmuck", "other-carved-cast"],           // ornaments rank at least 40 (owner 2026-10-09)
  ["Ohrschmuck (Kleinkunst / Schmuck / Kopfschmuck)", "other-carved-cast"],
  ["Hocker", "other-carved-cast"],
  ["Schlitztrommel mit Schlegel", "carved-instrument"],
  ["Röhrentrommeln", "carved-instrument"],       // plural
  ["Schalenzither", "carved-instrument"],        // a zither, not a bowl
  ["Schalenleier", "carved-instrument"],
  ["Blashorn", "carved-instrument"],
  ["Ziegenglocke", "other"],                     // bells are not carved
  ["Positiv, SW", "archive"],
  ["Postkarte (Positiv, SW)", "archive"],
  ["Dia, Farbe", "archive"],
  ["Schellackplatte", "archive"],
  ["Tonband", "archive"],
  ["Holzprobe", "specimen"],
  ["Korb", "other"],
  ["Kalebasse (bemalt)", "other"],
  ["Armring", "other-carved-cast"],
  ["", "other"],
];

describe("classify", () => {
  it.each(cases)("%s -> %s", (objectType, expected) => {
    expect(classify(objectType, profile)).toBe(expected);
  });

  it("treats null and undefined as other", () => {
    expect(classify(null, profile)).toBe("other");
    expect(classify(undefined, profile)).toBe("other");
  });

  it("matches multi-word phrases", () => {
    expect(classify("Slit drum, wood", profile)).toBe("carved-instrument");
  });
});
