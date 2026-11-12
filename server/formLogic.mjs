// Form rules shared by the account service and the browser.
// Keep this file dependency-free: it is imported by Node and bundled by Vite.

export const FIELD_TYPES = [
  "short", "long", "email", "phone", "number", "url", "date", "time",
  "single", "multi", "dropdown", "yesno", "scale", "rating", "state", "consent", "statement"
];
export const CHOICE_TYPES = ["single", "multi", "dropdown"];
export const OPERATORS = ["eq", "neq", "contains", "not_contains", "gt", "lt", "any_of", "answered", "empty"];
export const OTHER_PREFIX = "~";

export const INDIA_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep",
  "Puducherry", "Outside India"
];

const text = (value, limit) => (typeof value === "string" ? value : "").replace(/\u0000/g, "").trim().slice(0, limit);
const idOk = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
let counter = 0;
export function newId(prefix = "f") {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const isEmpty = value => value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);

/** Human-readable answer, resolving option ids and "Other" text. */
export function displayAnswer(field, value) {
  if (isEmpty(value)) return "";
  const one = item => {
    if (typeof item !== "string") return String(item);
    if (item.startsWith(OTHER_PREFIX)) return item.slice(1);
    if (CHOICE_TYPES.includes(field.type)) return field.options?.find(option => option.id === item)?.label ?? item;
    return item;
  };
  if (field.type === "consent") return value ? "Yes" : "No";
  return Array.isArray(value) ? value.map(one).join(", ") : one(value);
}

function ruleMatches(rule, fieldsById, answers) {
  const field = fieldsById.get(rule.field);
  if (!field) return false;
  const raw = answers[rule.field];
  const values = (Array.isArray(raw) ? raw : isEmpty(raw) ? [] : [raw]).map(String);
  const shown = values.map(value => displayAnswer(field, value).toLowerCase());
  const target = String(rule.value ?? "");
  const targets = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(item => String(item ?? ""));
  const hit = candidate => values.includes(candidate) || shown.includes(candidate.toLowerCase());
  switch (rule.op) {
    case "answered": return values.length > 0;
    case "empty": return values.length === 0;
    case "eq": return hit(target);
    case "neq": return !hit(target);
    case "any_of": return targets.some(hit);
    case "contains": return shown.some(value => value.includes(target.toLowerCase()));
    case "not_contains": return !shown.some(value => value.includes(target.toLowerCase()));
    case "gt": return values.length > 0 && Number(values[0]) > Number(target);
    case "lt": return values.length > 0 && Number(values[0]) < Number(target);
    default: return false;
  }
}

/** An empty or missing condition always passes. */
export function conditionPasses(condition, fieldsById, answers) {
  const rules = condition?.rules?.filter(rule => rule && rule.field) ?? [];
  if (!rules.length) return true;
  const results = rules.map(rule => ruleMatches(rule, fieldsById, answers));
  return condition.mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

export function allFields(schema) {
  return (schema?.pages ?? []).flatMap(page => page.fields ?? []);
}

/**
 * The pages a respondent actually walks through, following skip rules.
 * Jumps only move forward, so a path always terminates.
 */
export function pagePath(schema, answers) {
  const pages = schema?.pages ?? [];
  const fieldsById = new Map(allFields(schema).map(field => [field.id, field]));
  const path = [];
  let index = 0;
  while (index < pages.length) {
    const page = pages[index];
    path.push(page);
    let next = index + 1;
    for (const jump of page.jumps ?? []) {
      if (!conditionPasses(jump.when, fieldsById, answers)) continue;
      if (jump.to === "submit") { next = pages.length; break; }
      const target = pages.findIndex(candidate => candidate.id === jump.to);
      if (target > index) { next = target; break; }
    }
    index = next;
  }
  return path;
}

export function visibleFields(schema, answers, pages = pagePath(schema, answers)) {
  const fieldsById = new Map(allFields(schema).map(field => [field.id, field]));
  return pages.flatMap(page => (page.fields ?? []).filter(field => conditionPasses(field.showIf, fieldsById, answers)));
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const PHONE = /^\+?[0-9][0-9\s().-]{5,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

function checkField(field, value) {
  const rules = field.validation ?? {};
  const lengthCheck = string => {
    if (rules.minLength && string.length < rules.minLength) return `Use at least ${rules.minLength} characters.`;
    if (rules.maxLength && string.length > rules.maxLength) return `Keep this under ${rules.maxLength} characters.`;
    if (rules.pattern) {
      try { if (!new RegExp(rules.pattern, "u").test(string)) return rules.patternMessage || "This answer isn't in the expected format."; }
      catch { /* An invalid saved pattern never blocks a respondent. */ }
    }
    return null;
  };
  const choice = item => typeof item === "string" && (field.options?.some(option => option.id === item) || (field.allowOther && item.startsWith(OTHER_PREFIX) && item.length > 1 && item.length <= 301));
  switch (field.type) {
    case "short": case "long": {
      if (typeof value !== "string" || value.length > (field.type === "long" ? 5000 : 500)) return "This answer is too long.";
      return lengthCheck(value);
    }
    case "email": return typeof value === "string" && EMAIL.test(value) ? null : "Enter a valid email address, like name@example.com.";
    case "phone": return typeof value === "string" && PHONE.test(value) && value.replace(/\D/g, "").length >= 7 ? null : "Enter a valid phone number, with country code if outside India.";
    case "url": try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? null : "Start the link with https://"; } catch { return "Enter a full link, starting with https://"; }
    case "number": {
      const number = Number(value);
      if (typeof value === "boolean" || value === "" || !Number.isFinite(number)) return "Enter a number.";
      if (rules.min !== undefined && rules.min !== null && number < rules.min) return `Enter ${rules.min} or more.`;
      if (rules.max !== undefined && rules.max !== null && number > rules.max) return `Enter ${rules.max} or less.`;
      return null;
    }
    case "date": return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value)) ? null : "Choose a date.";
    case "time": return typeof value === "string" && TIME.test(value) ? null : "Choose a time.";
    case "single": case "dropdown": return choice(value) ? null : "Choose one of the options.";
    case "multi": {
      if (!Array.isArray(value) || value.length > 60 || !value.every(choice) || new Set(value).size !== value.length) return "Choose from the options.";
      if (rules.min && value.length < rules.min) return `Choose at least ${rules.min}.`;
      if (rules.max && value.length > rules.max) return `Choose at most ${rules.max}.`;
      return null;
    }
    case "yesno": return value === "yes" || value === "no" ? null : "Choose yes or no.";
    case "scale": case "rating": {
      const min = field.type === "rating" ? 1 : field.scale?.min ?? 1, max = field.type === "rating" ? field.scale?.max ?? 5 : field.scale?.max ?? 5;
      return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? null : `Choose a value from ${min} to ${max}.`;
    }
    case "state": return INDIA_STATES.includes(value) ? null : "Choose your state or union territory.";
    case "consent": return value === true ? null : "Tick the box to continue.";
    default: return null;
  }
}

/**
 * Validate answers against the questions a respondent could actually see.
 * Answers to hidden or skipped questions are dropped rather than rejected.
 * `onlyPage` limits required-checks to one page (used while paging).
 */
export function validateAnswers(schema, answers, onlyPage) {
  const input = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const errors = {}, clean = {};
  const pages = pagePath(schema, input);
  for (const field of visibleFields(schema, input, pages)) {
    if (field.type === "statement") continue;
    if (onlyPage && !onlyPage.fields?.some(candidate => candidate.id === field.id)) {
      if (!isEmpty(input[field.id])) clean[field.id] = input[field.id];
      continue;
    }
    let value = input[field.id];
    if (typeof value === "string") value = value.trim();
    if (isEmpty(value)) { if (field.required) errors[field.id] = field.type === "consent" ? "Tick the box to continue." : "This question needs an answer."; continue; }
    const problem = checkField(field, value);
    if (problem) errors[field.id] = problem;
    else clean[field.id] = ["number", "scale", "rating"].includes(field.type) ? Number(value) : value;
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

function normalizeCondition(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.rules)) return undefined;
  const rules = value.rules.slice(0, 12).flatMap(rule => {
    if (!rule || !idOk(rule.field) || !OPERATORS.includes(rule.op)) return [];
    const target = Array.isArray(rule.value) ? rule.value.slice(0, 30).map(item => text(String(item), 300)) : text(String(rule.value ?? ""), 300);
    return [{ field: rule.field, op: rule.op, value: target }];
  });
  return rules.length ? { mode: value.mode === "any" ? "any" : "all", rules } : undefined;
}

const numberOr = (value, fallback) => (value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value));

/** Clean an edited form definition before it is stored. Throws on unusable input. */
export function normalizeSchema(input) {
  const pagesIn = Array.isArray(input?.pages) ? input.pages.slice(0, 30) : [];
  if (!pagesIn.length) throw new Error("A form needs at least one page.");
  const seen = new Set();
  const unique = (candidate, prefix) => { let id = idOk(candidate) && !seen.has(candidate) ? candidate : newId(prefix); while (seen.has(id)) id = newId(prefix); seen.add(id); return id; };
  let total = 0;
  const pages = pagesIn.map(page => {
    const fields = (Array.isArray(page?.fields) ? page.fields : []).flatMap(field => {
      if (!field || !FIELD_TYPES.includes(field.type) || ++total > 200) return [];
      const next = { id: unique(field.id, "q"), type: field.type, label: text(field.label, 400) || "Untitled question" };
      const help = text(field.help, 1000); if (help) next.help = help;
      if (field.required && field.type !== "statement") next.required = true;
      const placeholder = text(field.placeholder, 120); if (placeholder) next.placeholder = placeholder;
      const role = text(field.role, 24); if (/^[a-z_]{1,24}$/.test(role)) next.role = role;
      if (CHOICE_TYPES.includes(field.type)) {
        const optionIds = new Set();
        next.options = (Array.isArray(field.options) ? field.options : []).slice(0, 80).flatMap(option => {
          const label = text(typeof option === "string" ? option : option?.label, 200);
          if (!label) return [];
          let id = idOk(option?.id) && !optionIds.has(option.id) ? option.id : newId("o");
          while (optionIds.has(id)) id = newId("o");
          optionIds.add(id);
          return [{ id, label }];
        });
        if (!next.options.length) next.options = [{ id: newId("o"), label: "Option 1" }];
        if (field.allowOther && field.type !== "dropdown") next.allowOther = true;
      }
      if (field.type === "scale" || field.type === "rating") {
        const min = field.type === "rating" ? 1 : Math.min(1, Math.max(0, Math.round(numberOr(field.scale?.min, 1))));
        const max = Math.min(10, Math.max(min + 1, Math.round(numberOr(field.scale?.max, 5))));
        next.scale = { min, max };
        const minLabel = text(field.scale?.minLabel, 40), maxLabel = text(field.scale?.maxLabel, 40);
        if (minLabel) next.scale.minLabel = minLabel;
        if (maxLabel) next.scale.maxLabel = maxLabel;
      }
      const rules = field.validation ?? {}, validation = {};
      for (const key of ["min", "max", "minLength", "maxLength"]) { const number = numberOr(rules[key], null); if (number !== null) validation[key] = number; }
      const pattern = text(rules.pattern, 200);
      if (pattern) { try { new RegExp(pattern, "u"); validation.pattern = pattern; const message = text(rules.patternMessage, 160); if (message) validation.patternMessage = message; } catch { /* Drop unusable patterns. */ } }
      if (Object.keys(validation).length) next.validation = validation;
      next._showIf = field.showIf;
      return [next];
    });
    const next = { id: unique(page?.id, "p"), title: text(page?.title, 200), fields };
    const description = text(page?.description, 2000); if (description) next.description = description;
    next._jumps = page?.jumps;
    return next;
  });
  const fieldIds = new Set(pages.flatMap(page => page.fields.map(field => field.id)));
  const pageIds = new Set(pages.map(page => page.id));
  const known = condition => { const cleaned = normalizeCondition(condition); if (!cleaned) return undefined; cleaned.rules = cleaned.rules.filter(rule => fieldIds.has(rule.field)); return cleaned.rules.length ? cleaned : undefined; };
  for (const page of pages) {
    for (const field of page.fields) { const showIf = known(field._showIf); delete field._showIf; if (showIf) field.showIf = showIf; }
    const jumps = (Array.isArray(page._jumps) ? page._jumps : []).slice(0, 10).flatMap(jump => {
      const when = known(jump?.when);
      return when && (jump.to === "submit" || pageIds.has(jump.to)) ? [{ when, to: jump.to }] : [];
    });
    delete page._jumps;
    if (jumps.length) page.jumps = jumps;
  }
  return { pages };
}

/** Replace {{questionId}} in a label with the respondent's earlier answer. */
export function pipeText(template, schema, answers) {
  if (!template || !template.includes("{{")) return template ?? "";
  const fields = new Map(allFields(schema).map(field => [field.id, field]));
  return template.replace(/\{\{\s*([A-Za-z0-9_-]{1,40})\s*\}\}/g, (match, id) => {
    const field = fields.get(id);
    return field ? displayAnswer(field, answers[id]) || "…" : match;
  });
}
