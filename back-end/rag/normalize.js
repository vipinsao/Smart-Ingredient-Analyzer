// rag/normalize.js - Turn Open Food Facts taxonomy entries into retrievable
// passages.
//
// Source: Open Food Facts taxonomies, ODbL v1.0. See CORPUS.md for the
// attribution and share-alike obligations that licence carries.
//
// Pure functions: an entry in, a passage out. No network, no filesystem, so
// the shape of every passage is unit-testable without a corpus.

/** "en:preservative" -> "preservative"; "en:high" -> "high". */
export function stripLangPrefix(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\b[a-z]{2}:/g, "").trim();
}

/** Read the English value out of an Open Food Facts multilingual field. */
export function englishValue(field) {
  if (!field || typeof field !== "object") return "";
  return typeof field.en === "string" ? field.en.trim() : "";
}

/**
 * OFF writes additive names as "E211 - Sodium benzoate". Split that into the
 * code and the substance name so both can be indexed as aliases: a label says
 * "INS211" or "E211", a question says "sodium benzoate", and lexical search
 * needs to find the passage from either.
 */
export function splitAdditiveName(name) {
  const match = /^\s*(E\s?\d+[a-z]*(?:\([a-z]+\))?)\s*[-–—:]\s*(.+)$/i.exec(name || "");
  if (!match) return { code: "", label: (name || "").trim() };
  return { code: match[1].replace(/\s+/g, "").toUpperCase(), label: match[2].trim() };
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(" ");
}

function readableList(value) {
  const cleaned = stripLangPrefix(value);
  return cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * One additive -> one passage.
 *
 * Everything stated in the passage comes from a field in the taxonomy. Nothing
 * is inferred, because the point of the corpus is that a generated verdict can
 * be traced back to a line somebody else published.
 */
export function additiveToPassage(id, entry, { classNames = {} } = {}) {
  const rawName = englishValue(entry.name);
  if (!rawName) return null;

  const { code, label } = splitAdditiveName(rawName);
  const eNumber = englishValue(entry.e_number);
  const displayCode = code || (eNumber ? `E${eNumber}` : "");
  const title = displayCode ? `${displayCode} ${label}` : label;

  const classIds = stripLangPrefix(englishValue(entry.additives_classes))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const classes = classIds.map((key) => classNames[`en:${key}`] || key);

  const sentences = [];
  sentences.push(`${title} is a food additive listed in the Open Food Facts additives taxonomy.`);

  if (classes.length > 0) {
    sentences.push(`Additive class: ${classes.join(", ")}.`);
  }

  const description = englishValue(entry.description);
  if (description) sentences.push(`${description}.`.replace(/\.\.$/, "."));

  const overexposure = stripLangPrefix(englishValue(entry.efsa_evaluation_overexposure_risk));
  if (overexposure) {
    sentences.push(`EFSA overexposure risk for this additive is assessed as ${overexposure}.`);
  }

  const meanOver = readableList(englishValue(entry.efsa_evaluation_exposure_mean_greater_than_adi));
  if (meanOver) {
    sentences.push(`EFSA found mean exposure above the acceptable daily intake for: ${meanOver}.`);
  }

  const p95Over = readableList(englishValue(entry.efsa_evaluation_exposure_95th_greater_than_adi));
  if (p95Over) {
    sentences.push(`EFSA found 95th percentile exposure above the acceptable daily intake for: ${p95Over}.`);
  }

  const adi = englishValue(entry.efsa_evaluation_adi);
  if (adi) sentences.push(`EFSA acceptable daily intake: ${adi}.`);

  if (englishValue(entry.anses_additives_of_interest) === "yes") {
    sentences.push("ANSES lists this additive as an additive of interest.");
  }

  const vegan = englishValue(entry.vegan);
  const vegetarian = englishValue(entry.vegetarian);
  if (vegan || vegetarian) {
    sentences.push(`Vegan: ${vegan || "unknown"}. Vegetarian: ${vegetarian || "unknown"}.`);
  }

  const evaluationDate = englishValue(entry.efsa_evaluation_date);
  const evaluationUrl = englishValue(entry.efsa_evaluation_url);
  if (evaluationUrl) {
    sentences.push(`EFSA evaluation${evaluationDate ? ` (${evaluationDate})` : ""}: ${evaluationUrl}`);
  }

  // Aliases are what lexical search matches on: the E code, the INS spelling
  // used on Indian labels, and the substance name.
  const aliases = [label, displayCode, eNumber ? `E${eNumber}` : "", eNumber ? `INS${eNumber}` : ""].filter(Boolean);

  return {
    id: `additive:${id}`,
    kind: "additive",
    title,
    aliases: [...new Set(aliases)],
    text: joinSentences(sentences),
    source: {
      dataset: "Open Food Facts additives taxonomy",
      licence: "ODbL-1.0",
      entry: id,
      url: `https://world.openfoodfacts.org/additive/${id.replace(/^en:/, "")}`,
    },
  };
}

/** One additive class (preservative, emulsifier, ...) -> one passage. */
export function additiveClassToPassage(id, entry) {
  const name = typeof entry.name === "string" ? entry.name : englishValue(entry.name);
  const description = typeof entry.description === "string" ? entry.description : englishValue(entry.description);
  if (!name || !description) return null;

  return {
    id: `additive-class:${id}`,
    kind: "additive-class",
    title: name,
    aliases: [name],
    text: `${name} is a class of food additive. ${description}`,
    source: {
      dataset: "Open Food Facts additives classes taxonomy",
      licence: "ODbL-1.0",
      entry: id,
      url: "https://world.openfoodfacts.org/data",
    },
  };
}

/** One allergen -> one passage. The allergen taxonomy carries names only. */
export function allergenToPassage(id, entry) {
  const name = englishValue(entry.name);
  if (!name || id === "en:none") return null;

  return {
    id: `allergen:${id}`,
    kind: "allergen",
    title: name,
    aliases: [name],
    text:
      `${name} is listed as an allergen in the Open Food Facts allergens taxonomy. ` +
      `Allergens must be declared on food labels in the European Union when present as an ingredient.`,
    source: {
      dataset: "Open Food Facts allergens taxonomy",
      licence: "ODbL-1.0",
      entry: id,
      url: "https://world.openfoodfacts.org/allergens",
    },
  };
}

export default { additiveToPassage, additiveClassToPassage, allergenToPassage, splitAdditiveName, stripLangPrefix, englishValue };
