import { DEFAULT_ALIASES, type AliasEntry } from "./aliases";

// Words that look like proper nouns when capitalized at sentence-start, but
// almost always are not. Single source of truth. Add freely.
//
// Strategy: a single capitalized word is rejected if it appears in this list,
// UNLESS the same surface form also appears as an alias key.
const COMMON_WORDS = new Set<string>([
  // Modal / auxiliary
  "will", "would", "could", "should", "shall", "may", "might", "can", "must",
  "have", "has", "had", "having", "be", "been", "being", "do", "does", "did",
  "is", "are", "was", "were", "am", "ain", "aren", "isn", "wasn", "weren",
  "won", "wouldn", "couldn", "shouldn", "haven", "hasn", "hadn", "doesn", "didn", "don",
  "cannot", "cant", "wont", "dont", "didnt", "doesnt", "isnt", "arent",

  // Common verbs & participles
  "get", "got", "gets", "getting", "gotten",
  "give", "gives", "gave", "given", "giving",
  "take", "takes", "took", "taken", "taking",
  "make", "makes", "made", "making",
  "come", "comes", "came", "coming",
  "go", "goes", "went", "gone", "going",
  "say", "says", "said", "saying",
  "see", "sees", "saw", "seen", "seeing",
  "look", "looks", "looked", "looking",
  "know", "knows", "knew", "known", "knowing",
  "think", "thinks", "thought", "thinking",
  "want", "wants", "wanted", "wanting",
  "find", "finds", "found", "finding",
  "tell", "tells", "told", "telling",
  "use", "uses", "used", "using",
  "help", "helps", "helped", "helping",
  "show", "shows", "showed", "shown", "showing",
  "need", "needs", "needed", "needing",
  "try", "tries", "tried", "trying",
  "bring", "brings", "brought", "bringing",
  "talk", "talks", "talked", "talking",
  "work", "works", "worked", "working",
  "run", "runs", "ran", "running",
  "move", "moves", "moved", "moving",
  "live", "lives", "lived", "living",
  "believe", "believes", "believed", "believing",
  "hold", "holds", "held", "holding",
  "allow", "allows", "allowed", "allowing",
  "stand", "stands", "stood", "standing",
  "mean", "means", "meant", "meaning",
  "set", "sets", "setting",
  "learn", "learns", "learned", "learning",
  "change", "changes", "changed", "changing",
  "lead", "leads", "led", "leading",
  "understand", "understands", "understood", "understanding",
  "watch", "watches", "watched", "watching",
  "follow", "follows", "followed", "following",
  "stop", "stops", "stopped", "stopping",
  "create", "creates", "created", "creating",
  "speak", "speaks", "spoke", "spoken", "speaking",
  "read", "reads", "reading",
  "spend", "spends", "spent", "spending",
  "grow", "grows", "grew", "grown", "growing",
  "open", "opens", "opened", "opening",
  "walk", "walks", "walked", "walking",
  "win", "wins", "won", "winning",
  "offer", "offers", "offered", "offering",
  "remember", "remembers", "remembered", "remembering",
  "consider", "considers", "considered", "considering",
  "appear", "appears", "appeared", "appearing",
  "buy", "buys", "bought", "buying",
  "wait", "waits", "waited", "waiting",
  "serve", "serves", "served", "serving",
  "die", "dies", "died", "dying",
  "send", "sends", "sent", "sending",
  "build", "builds", "built", "building",
  "stay", "stays", "stayed", "staying",
  "fall", "falls", "fell", "fallen", "falling",
  "cut", "cuts", "cutting",
  "reach", "reaches", "reached", "reaching",
  "kill", "kills", "killed", "killing",
  "raise", "raises", "raised", "raising",
  "pass", "passes", "passed", "passing",
  "sell", "sells", "sold", "selling",
  "decide", "decides", "decided", "deciding",
  "return", "returns", "returned", "returning",
  "explain", "explains", "explained", "explaining",
  "hope", "hopes", "hoped", "hoping",
  "develop", "develops", "developed", "developing",
  "carry", "carries", "carried", "carrying",
  "break", "breaks", "broke", "broken", "breaking",
  "receive", "receives", "received", "receiving",
  "agree", "agrees", "agreed", "agreeing",
  "support", "supports", "supported", "supporting",
  "hit", "hits", "hitting",
  "produce", "produces", "produced", "producing",
  "eat", "eats", "ate", "eaten", "eating",
  "cover", "covers", "covered", "covering",
  "catch", "catches", "caught", "catching",
  "draw", "draws", "drew", "drawn", "drawing",
  "choose", "chooses", "chose", "chosen", "choosing",
  "cause", "causes", "caused", "causing",
  "note", "notes", "noted", "noting",
  "lose", "loses", "lost", "losing",
  "plan", "plans", "planned", "planning",
  "drive", "drives", "drove", "driven", "driving",
  "wonder", "wonders", "wondered", "wondering",
  "happen", "happens", "happened", "happening",
  "suggest", "suggests", "suggested", "suggesting",
  "expect", "expects", "expected", "expecting",
  "claim", "claims", "claimed", "claiming",
  "start", "starts", "started", "starting",
  "finish", "finishes", "finished", "finishing",
  "leave", "leaves", "left", "leaving",
  "put", "puts", "putting",
  "feel", "feels", "felt", "feeling",
  "let", "lets", "letting",
  "ask", "asks", "asked", "asking",
  "seem", "seems", "seemed", "seeming",
  "keep", "keeps", "kept", "keeping",
  "begin", "begins", "began", "begun", "beginning",
  "turn", "turns", "turned", "turning",
  "increase", "increases", "increased", "increasing",
  "include", "includes", "included", "including",
  "continue", "continues", "continued", "continuing",
  "add", "adds", "added", "adding",
  "remove", "removes", "removed", "removing",
  "play", "plays", "played", "playing",
  "force", "forces", "forced", "forcing",
  "fight", "fights", "fought", "fighting",
  "deal", "deals", "dealt", "dealing",
  "matter", "matters", "mattered", "mattering",
  "check", "checks", "checked", "checking",
  "refer", "refers", "referred", "referring",
  "share", "shares", "shared", "sharing",
  "click", "clicks", "clicked", "clicking",
  "subscribe", "subscribes", "subscribed", "subscribing",
  "join", "joins", "joined", "joining",
  "watch", "view", "views", "viewed", "viewing",
  "doing", "done", "having",
  "save", "saves", "saved", "saving",
  "post", "posts", "posted", "posting",
  "share", "shared",
  "close", "closes", "closed", "closing",
  "near", "nearer", "nearest", "far", "farther", "further", "furthest",
  "edit", "edits", "edited", "editing",
  "update", "updates", "updated", "updating",

  // Adjectives — comparative, superlative, descriptive
  "good", "better", "best", "great",
  "bad", "worse", "worst",
  "big", "bigger", "biggest", "small", "smaller", "smallest",
  "large", "larger", "largest",
  "long", "longer", "longest", "short", "shorter", "shortest",
  "high", "higher", "highest", "low", "lower", "lowest",
  "right", "wrong", "left",
  "real", "true", "false", "actual",
  "new", "old", "young", "ancient", "modern",
  "many", "few", "much", "more", "most", "less", "least",
  "other", "others", "another", "same", "different", "similar", "various",
  "important", "easy", "hard", "difficult", "simple",
  "late", "early", "recent",
  "sure", "probable", "possible", "impossible", "likely", "unlikely",
  "strong", "stronger", "strongest", "weak", "weaker", "weakest",
  "free", "public", "private", "local", "national", "international", "global",
  "major", "minor", "full", "empty", "whole", "complete", "partial",
  "final", "first", "last", "next", "previous",
  "several", "some", "any", "all", "each", "every", "both", "either", "neither",
  "quick", "slow", "fast",
  "huge", "tiny", "vast", "minimal",
  "nice", "fine", "awful", "amazing", "incredible", "fantastic", "terrible",
  "smart", "stupid", "clever", "wise", "foolish",
  "happy", "sad", "angry", "surprised", "shocked", "scared", "afraid",
  "interesting", "boring", "obvious", "subtle", "clear", "unclear", "vague",
  "open", "closed", "shut",
  "rich", "poor", "wealthy", "broke",
  "popular", "unpopular", "famous", "unknown",
  "official", "unofficial", "formal", "informal",
  "perfect", "imperfect", "ideal", "typical", "normal", "abnormal",
  "active", "inactive", "busy", "lazy",
  "warm", "cold", "hot", "cool",
  "bright", "dark", "light", "heavy",
  "deep", "shallow", "wide", "narrow",
  "loud", "quiet", "silent",
  "clean", "dirty", "fresh", "stale",
  "safe", "dangerous", "risky",
  "natural", "artificial", "fake", "genuine",
  "common", "rare", "ordinary", "unique",
  "useful", "useless", "helpful", "unhelpful",
  "necessary", "unnecessary", "essential",
  "absolute", "relative", "specific", "general",
  "real", "imaginary", "virtual", "physical",
  "primary", "secondary", "main", "central", "peripheral",
  "obvious", "hidden", "visible", "invisible",
  "single", "double", "triple", "multiple", "single",
  "current", "former", "future", "past", "present",
  "inefficient", "inefficiencies", "efficient",

  // Adverbs / discourse markers
  "just", "only", "also", "still", "even", "however", "therefore", "yet",
  "already", "now", "then", "here", "there", "soon", "later", "earlier",
  "often", "sometimes", "always", "never", "rarely", "occasionally",
  "well", "quite", "almost", "very", "too", "so", "rather", "pretty",
  "really", "truly", "maybe", "perhaps", "surely", "certainly", "indeed",
  "especially", "actually", "probably", "specifically", "particularly", "usually",
  "moreover", "furthermore", "nevertheless", "nonetheless", "thus", "hence",
  "anyway", "anyhow", "besides", "instead", "otherwise", "meanwhile", "similarly",
  "likewise", "conversely", "alternatively", "consequently", "accordingly",
  "basically", "essentially", "fundamentally", "obviously", "clearly", "apparently",
  "supposedly", "hopefully", "thankfully", "luckily", "unfortunately",

  // Quantifiers / determiners / pronouns
  "the", "a", "an", "this", "that", "these", "those", "each", "every", "both",
  "either", "neither", "such", "same", "which", "whose", "who", "whom", "whoever",
  "whatever", "whichever", "anything", "everything", "nothing", "something",
  "anyone", "everyone", "noone", "someone", "anybody", "everybody", "nobody", "somebody",
  "anywhere", "everywhere", "nowhere", "somewhere",
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "yourselves", "themselves",
  // Personal pronouns (often capitalized at sentence start)
  "i", "me", "my", "mine",
  "you", "your", "yours",
  "he", "him", "his",
  "she", "her", "hers",
  "it", "its",
  "we", "us", "our", "ours",
  "they", "them", "their", "theirs",

  // Time words
  "today", "tomorrow", "yesterday", "tonight", "morning", "evening", "afternoon",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "spring", "summer", "autumn", "winter", "fall",
  "once", "twice", "thrice", "currently", "recently", "previously",

  // Generic nouns that read like proper nouns when capitalized
  "money", "people", "person", "time", "year", "day", "week", "month",
  "world", "country", "place", "thing", "way", "case", "fact", "issue",
  "problem", "question", "answer", "reason", "result", "effect", "cause",
  "number", "amount", "level", "rate", "side", "part", "end", "beginning",
  "start", "term", "name", "word", "letter", "hour", "minute", "second",
  "system", "process", "situation", "condition", "context",
  "source", "sources", "link", "links", "type", "types",
  "seat", "seats", "vote", "votes", "voter", "voters",
  "post", "posts", "tweet", "tweets", "video", "videos", "audio",
  "image", "images", "photo", "photos", "picture", "pictures",
  "page", "pages", "site", "sites",
  "report", "reports", "story", "stories", "news",
  "thread", "threads", "comment", "comments", "reply", "replies",
  "channel", "group", "list",
  "please", "thanks", "thank", "regards", "cheers",
  "reader", "readers", "viewer", "viewers", "subscriber", "subscribers",
  "user", "users", "follower", "followers",
  "everyone", "anyone", "someone", "nobody",

  // Conjunctions / prepositions
  "but", "and", "or", "nor", "if", "while", "although", "though", "unless", "until",
  "as", "because", "since", "when", "where", "why", "how", "what",
  "about", "above", "below", "before", "after", "during", "through",
  "across", "against", "among", "behind", "beside", "between", "beyond",
  "outside", "inside", "toward", "within", "without",
  // Basic short prepositions / function words
  "for", "from", "with", "to", "by", "of", "in", "on", "at", "off", "up", "down",
  "into", "onto", "upon", "over", "under", "near", "via",
  "not", "yes", "no", "than",

  // Numbers / ordinals
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "hundred", "thousand", "million", "billion", "trillion", "dozen",
  "single", "double", "triple",
  "earlier", "latter", "former", "later",

  // Channel-style filler
  "edited", "edit", "via", "etc", "ie", "eg",
  "yes", "no", "maybe", "ok", "okay", "alright",
  "lol", "haha", "omg", "btw", "tbh", "imo", "imho",

  // English titles (no political signal)
  "mr", "mrs", "ms", "dr", "sir", "madam", "lord", "lady",

  // Sentence starters specifically observed in the user's screenshot
  "rich", "comes", "would", "should", "could", "ji"
]);

// Acronyms that are real English noise (not entities the user cares about)
const ACRONYM_BLOCKLIST = new Set<string>([
  "URL", "USB", "AKA", "ETC", "FAQ", "DIY", "FYI", "ASAP", "TBD", "TBH",
  "LOL", "OMG", "IMO", "IMHO", "BTW", "AKA", "PS", "CC", "BCC",
  "I", "A"
]);

// Explicit blocklist that survives all detection. Add words you don't want to
// see, even if they pass other checks. Editable like aliases.ts.
export const ENTITY_BLOCKLIST = new Set<string>([
  // Add user-specific noise here as it surfaces, e.g. "Aaloo", "Tihar" etc.
]);

const ACRONYM_RE = /\b[A-Z]{2,6}\b/g;
const PROPER_NOUN_RE = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2}\b/g;
const HASHTAG_RE = /#([A-Za-z][A-Za-z0-9_]{2,})/g;
const SENTENCE_END_RE = /[.!?]\s+$/;

interface CompiledAlias {
  pattern: RegExp;
  canonical: string;
}

function compileAliases(aliases: AliasEntry[]): CompiledAlias[] {
  return aliases.map((entry) => {
    const flag = entry.caseInsensitive === false ? "g" : "gi";
    const escaped = entry.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      pattern: new RegExp(`\\b${escaped}\\b`, flag),
      canonical: entry.canonical
    };
  });
}

let cachedCompiled: CompiledAlias[] | null = null;
let aliasMatchSet: Set<string> | null = null;
let extraUserAliases: AliasEntry[] = [];

function getCompiledAliases(): CompiledAlias[] {
  if (!cachedCompiled) {
    cachedCompiled = compileAliases([...DEFAULT_ALIASES, ...extraUserAliases]);
  }
  return cachedCompiled;
}

function getAliasMatchSet(): Set<string> {
  if (!aliasMatchSet) {
    aliasMatchSet = new Set(
      [...DEFAULT_ALIASES, ...extraUserAliases].map((a) => a.match.toLowerCase())
    );
  }
  return aliasMatchSet;
}

/** Inject user-defined aliases at runtime. Resets compiled-alias caches. */
export function setUserAliases(aliases: AliasEntry[]): void {
  extraUserAliases = aliases;
  cachedCompiled = null;
  aliasMatchSet = null;
}

/**
 * Hits found in a single message. `confidence` flags which extractions were
 * "weak" (single capitalized word at sentence start) so the worker can later
 * decide whether to keep them based on global signals.
 */
export interface MessageHit {
  canonical: string;
  isStrong: boolean; // false for low-confidence single-word sentence-starters
}

function isWordInAliasSet(word: string): boolean {
  return getAliasMatchSet().has(word.toLowerCase());
}

function isAtSentenceStart(text: string, matchIndex: number): boolean {
  if (matchIndex === 0) return true;
  // Look back through whitespace to the previous non-space char
  let i = matchIndex - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  return ".!?".includes(text[i]);
}

/**
 * Extract entity hits from a single message's text, with strength flags.
 * The worker should aggregate these globally: drop weak hits whose canonical
 * never has a strong appearance.
 */
export function extractMessageHits(text: string): MessageHit[] {
  if (!text) return [];
  const hits: MessageHit[] = [];
  const seen = new Set<string>();
  const aliasHits = new Set<string>();

  // 1. Aliases (always strong)
  for (const { pattern, canonical } of getCompiledAliases()) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      if (!seen.has(canonical)) {
        hits.push({ canonical, isStrong: true });
        seen.add(canonical);
      }
      aliasHits.add(canonical);
    }
  }

  // 2. Hashtags (always strong)
  let m: RegExpExecArray | null;
  HASHTAG_RE.lastIndex = 0;
  while ((m = HASHTAG_RE.exec(text)) !== null) {
    const tag = `#${m[1]}`;
    if (m[1].length >= 3 && !seen.has(tag)) {
      hits.push({ canonical: tag, isStrong: true });
      seen.add(tag);
    }
  }

  // 3. Acronyms 2-6 letters all-caps (strong unless in blocklist)
  ACRONYM_RE.lastIndex = 0;
  while ((m = ACRONYM_RE.exec(text)) !== null) {
    const acro = m[0];
    if (acro.length < 2) continue;
    if (ACRONYM_BLOCKLIST.has(acro)) continue;
    if (ENTITY_BLOCKLIST.has(acro)) continue;
    if (isWordInAliasSet(acro)) continue; // already added via alias
    if (!seen.has(acro)) {
      hits.push({ canonical: acro, isStrong: true });
      seen.add(acro);
    }
  }

  // 4. Capitalized phrases. Two cases:
  //    - Multi-word phrase (Narendra Modi, West Bengal): always strong.
  //    - Single word at sentence start: weak (will be filtered later if it's
  //      in COMMON_WORDS or never appears mid-sentence elsewhere).
  //    - Single word mid-sentence: strong (almost always a real proper noun).
  PROPER_NOUN_RE.lastIndex = 0;
  while ((m = PROPER_NOUN_RE.exec(text)) !== null) {
    const phrase = m[0];
    const idx = m.index;
    if (ENTITY_BLOCKLIST.has(phrase)) continue;
    if (isWordInAliasSet(phrase)) continue;

    const lower = phrase.toLowerCase();
    const words = phrase.split(/\s+/);

    if (words.length >= 2) {
      // Multi-word: trim leading common words ("When Bangladesh" → "Bangladesh",
      // "Same Jat" → "Jat"). After trimming, if a single word remains, fall
      // through to the single-word branch.
      let trimmed = words;
      while (trimmed.length > 0 && COMMON_WORDS.has(trimmed[0].toLowerCase())) {
        trimmed = trimmed.slice(1);
      }
      if (trimmed.length === 0) continue;
      const trimmedPhrase = trimmed.join(" ");
      if (trimmed.length >= 2) {
        if (!seen.has(trimmedPhrase)) {
          hits.push({ canonical: trimmedPhrase, isStrong: true });
          seen.add(trimmedPhrase);
        }
        continue;
      }
      // Single word remaining — keep mid-sentence (it was inside a longer phrase
      // so it's not at sentence start by definition).
      const single = trimmed[0];
      if (COMMON_WORDS.has(single.toLowerCase())) continue;
      if (ENTITY_BLOCKLIST.has(single)) continue;
      if (!seen.has(single)) {
        hits.push({ canonical: single, isStrong: true });
        seen.add(single);
      }
      continue;
    }

    // Single word
    if (COMMON_WORDS.has(lower)) continue; // hard reject
    const atStart = isAtSentenceStart(text, idx);
    if (!seen.has(phrase)) {
      hits.push({ canonical: phrase, isStrong: !atStart });
      seen.add(phrase);
    } else if (!atStart) {
      // Upgrade an existing weak hit to strong if seen mid-sentence here
      for (const h of hits) {
        if (h.canonical === phrase) h.isStrong = true;
      }
    }
  }

  return hits;
}

/**
 * Backwards-compatible wrapper that returns only strong + alias hits as a Set
 * of canonical names. Use this in the runtime entity filter (App.tsx) where we
 * don't have global aggregation context.
 */
export function extractEntities(text: string): Set<string> {
  const hits = extractMessageHits(text);
  const out = new Set<string>();
  for (const h of hits) {
    if (h.isStrong) out.add(h.canonical);
  }
  return out;
}
