// Author shorthand → canonical entity. Add freely; matches are case-insensitive
// for short codes (DS, AS, BOJ) and case-sensitive for capitalized words
// (Brothers, tiger).
//
// The graph extractor will:
// 1. Match each key as a whole word in message text.
// 2. Display the value as the node label.
// 3. Group all matches under the canonical value.

export interface AliasEntry {
  match: string;            // string to match in text
  canonical: string;        // canonical name shown on the graph
  caseInsensitive?: boolean; // default true
}

export const DEFAULT_ALIASES: AliasEntry[] = [
  // Concepts
  { match: "DS", canonical: "Deep State" },
  { match: "MIC", canonical: "Military Industrial Complex" },
  { match: "BOJ", canonical: "Bank of Japan" },
  { match: "ECB", canonical: "European Central Bank" },
  { match: "FED", canonical: "US Federal Reserve" },
  { match: "RBI", canonical: "Reserve Bank of India" },

  // People (Indian politics — extend freely)
  { match: "AS", canonical: "Amit Shah" },
  { match: "PM", canonical: "PM Modi" },
  { match: "RG", canonical: "Rahul Gandhi" },
  { match: "SG", canonical: "Sonia Gandhi" },
  { match: "YS", canonical: "Yogi Adityanath" },

  // National-animal codes
  { match: "tiger", canonical: "India", caseInsensitive: false },
  { match: "Tiger", canonical: "India", caseInsensitive: false },
  { match: "dragon", canonical: "China", caseInsensitive: false },
  { match: "Dragon", canonical: "China", caseInsensitive: false },
  { match: "bear", canonical: "Russia", caseInsensitive: false },
  { match: "Bear", canonical: "Russia", caseInsensitive: false },
  { match: "eagle", canonical: "USA", caseInsensitive: false },
  { match: "Eagle", canonical: "USA", caseInsensitive: false },
  { match: "lion", canonical: "UK", caseInsensitive: false },
  { match: "Lion", canonical: "UK", caseInsensitive: false },

  // Royal / coded references
  { match: "Brothers", canonical: "UAE Royals", caseInsensitive: false },
  { match: "the brothers", canonical: "UAE Royals" }
];
