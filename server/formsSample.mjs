// Sample data mode: made-up responses for any form, so new admins and reviewers can see a
// populated console before real responses arrive.
//
// Each sample lives in its own in-memory SQLite database with its own FormsStore, so the real
// statistics, map and filtering code runs on it unchanged. Nothing is written to the real
// database, exports, backups, R2 or Telegram, and every sample belongs to one admin.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FormsStore } from "./formsStore.mjs";
import { allFields, districtsFor, validateAnswers, CHOICE_TYPES, INDIA_STATES, OTHER_PREFIX } from "./formLogic.mjs";

export const SAMPLE_REVIEWER = "sample.reviewer@example.com";
const DAY = 86400000;

/** Small seeded generator, so the same form always gets the same sample people. */
function generator(seed) {
  let state = createHash("sha256").update(String(seed)).digest().readUInt32LE(0) || 1;
  const next = () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = list => list[Math.floor(next() * list.length)];
  const weighted = entries => { const total = entries.reduce((sum, [, weight]) => sum + weight, 0); let roll = next() * total; for (const [value, weight] of entries) { roll -= weight; if (roll <= 0) return value; } return entries.at(-1)[0]; };
  const between = (low, high) => low + Math.floor(next() * (high - low + 1));
  const chance = probability => next() < probability;
  return { next, pick, weighted, between, chance };
}

const MALE = ["Aarav", "Arjun", "Rohan", "Vikram", "Siddharth", "Karan", "Aditya", "Rahul", "Nikhil", "Pranav", "Harsh", "Manish", "Yash", "Devansh", "Abhishek", "Gaurav", "Varun", "Kunal", "Ankit", "Saurabh", "Raghav", "Vivek", "Mohit", "Shubham", "Akash", "Tarun", "Deepak", "Rajat", "Ishaan", "Omkar"];
const FEMALE = ["Ananya", "Priya", "Kavya", "Diya", "Sneha", "Pooja", "Neha", "Aditi", "Ishita", "Meera", "Riya", "Shruti", "Tanvi", "Nandini", "Aishwarya", "Divya", "Swati", "Pallavi", "Radhika", "Sakshi", "Anjali", "Kritika", "Shreya", "Bhavna", "Lakshmi"];
const SURNAMES = {
  north: ["Sharma", "Verma", "Gupta", "Singh", "Yadav", "Mishra", "Pandey", "Tiwari", "Chauhan", "Rathore", "Srivastava", "Dubey", "Saxena", "Agarwal"],
  west: ["Patil", "Deshmukh", "Joshi", "Kulkarni", "Pawar", "Patel", "Shah", "Desai", "Mehta", "Bhatt"],
  south: ["Iyer", "Nair", "Reddy", "Rao", "Menon", "Krishnan", "Hegde", "Shetty", "Naidu"],
  east: ["Das", "Ghosh", "Banerjee", "Mukherjee", "Bose", "Sinha", "Jha", "Thakur", "Mahato", "Mohanty"],
  punjab: ["Gill", "Sandhu", "Kaur", "Bajwa", "Arora"]
};
const REGION = { Maharashtra: "west", Gujarat: "west", Goa: "west", Karnataka: "south", "Tamil Nadu": "south", Kerala: "south", Telangana: "south", "Andhra Pradesh": "south", "West Bengal": "east", Bihar: "east", Jharkhand: "east", Odisha: "east", Assam: "east", Punjab: "punjab" };
const STATES = [["Uttar Pradesh", 9], ["Maharashtra", 6], ["Bihar", 5], ["Madhya Pradesh", 4], ["Rajasthan", 4], ["Delhi", 4], ["Gujarat", 3], ["Karnataka", 3], ["Haryana", 2], ["Uttarakhand", 2], ["West Bengal", 2], ["Telangana", 2], ["Jharkhand", 1.5], ["Tamil Nadu", 1.5], ["Odisha", 1], ["Chhattisgarh", 1], ["Punjab", 1], ["Himachal Pradesh", 1], ["Assam", 1], ["Andhra Pradesh", 0.8], ["Kerala", 0.6], ["Jammu and Kashmir", 0.6], ["Goa", 0.3], ["Outside India", 0.5]];
const CITIES = {
  "Uttar Pradesh": ["Lucknow", "Prayagraj", "Varanasi", "Kanpur Nagar", "Agra", "Gorakhpur", "Ghaziabad", "Gautam Buddha Nagar", "Meerut", "Ayodhya", "Bareilly", "Mathura"],
  Maharashtra: ["Pune", "Mumbai", "Mumbai Suburban", "Nagpur", "Nashik", "Thane", "Chhatrapati Sambhajinagar", "Kolhapur"],
  Bihar: ["Patna", "Gaya", "Muzaffarpur", "Bhagalpur", "Darbhanga", "Begusarai"], "Madhya Pradesh": ["Bhopal", "Indore", "Jabalpur", "Gwalior", "Ujjain", "Sagar"],
  Rajasthan: ["Jaipur", "Jodhpur", "Udaipur", "Kota", "Ajmer", "Bikaner"], Delhi: ["New Delhi", "South Delhi", "North West Delhi", "East Delhi", "West Delhi"],
  Gujarat: ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Gandhinagar"], Karnataka: ["Bengaluru Urban", "Mysuru", "Belagavi", "Dakshina Kannada"],
  Haryana: ["Gurugram", "Faridabad", "Karnal", "Hisar"], Uttarakhand: ["Dehradun", "Haridwar", "Nainital"], "West Bengal": ["Kolkata", "Howrah", "Darjeeling"],
  Telangana: ["Hyderabad", "Warangal", "Medchal-Malkajgiri"], Jharkhand: ["Ranchi", "Dhanbad", "Purbi Singhbhum"], "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai"],
  Odisha: ["Khordha", "Cuttack", "Puri"], Chhattisgarh: ["Raipur", "Bilaspur"], Punjab: ["Ludhiana", "Amritsar", "Jalandhar"], "Himachal Pradesh": ["Shimla", "Kangra", "Mandi"],
  Assam: ["Kamrup Metro", "Dibrugarh"], "Andhra Pradesh": ["Visakhapatnam", "Guntur"], Kerala: ["Thiruvananthapuram", "Ernakulam"], "Jammu and Kashmir": ["Jammu", "Kathua"], Goa: ["North Goa", "South Goa"]
};
const LOCALITIES = ["Shastri Nagar", "Gandhi Nagar", "Civil Lines", "Rajendra Nagar", "Model Town", "Ram Nagar", "Saraswati Vihar", "Shivaji Nagar", "Indira Colony", "Vivekanand Marg", "Station Road", "Nehru Park", "Ashok Vihar", "Krishna Nagar", "Laxmi Nagar", "Subhash Chowk"];
const PROFESSIONS = ["Software engineer", "School teacher", "Chartered accountant", "Doctor", "Small business owner", "Farmer", "Government employee", "Lawyer", "Civil engineer", "Nurse", "Shopkeeper", "Bank officer", "Journalist", "Homemaker", "Architect", "Pharmacist", "Army veteran", "Sales manager", "Graphic designer", "Researcher", "Professor", "Electrician", "Retired teacher", "Content writer"];
const STUDENTS = ["Student, B.Tech", "Student, MBBS", "Student, BA History", "Student, B.Com", "Student, preparing for UPSC", "Student, LLB"];
const TEXT = {
  dharma: ["Teach Sanskrit and the Geeta to children in my locality every Sunday.", "Help run free health camps in nearby villages with doctor friends.", "Keep the accounts of our village temple honest and public.", "Offer free legal guidance to families who cannot afford a lawyer.", "Mentor young people from my district preparing for government exams.", "Start a small library of our scriptures and history books.", "Support cow shelters and organise feed drives during summer.", "Use my design skills to make our history easy for young people to read.", "Organise blood donation drives with my college friends.", "Help women in my area start home businesses and keep records.", "Clean and restore the old ghat near our town with volunteers.", "Translate good articles into Hindi and Marathi so more people can read them.", "Speak up calmly and with facts when our traditions are misrepresented.", "Build simple websites for temples and local seva groups for free.", "Visit government schools and talk to students about our heroes.", "Stand with families in my area during medical or legal trouble."],
  problems: ["Rent keeps rising and the daily commute takes three hours.", "Water shortage every summer and nobody is accountable.", "Not enough jobs for young people in my district.", "Corruption in small government offices for basic certificates.", "Poor roads and no proper bus service to the nearest city.", "Hospitals are far and expensive for my parents.", "Young people around me spend all day on their phones.", "Small traders like us are squeezed by big online platforms.", "Crop prices are uncertain and loans are hard to repay.", "Safety for women travelling late from work.", "Encroachment on temple land in our area."],
  influence: ["It taught me to think before reacting, especially online.", "I started reading the Geeta again, this time slowly and with notes.", "I plan my week around clear priorities instead of moods.", "I understand our history with more confidence and less anger.", "It changed how I handle conflict in my family and at work.", "I now judge leaders by their conduct, not their speeches.", "It made me more disciplined about money and time.", "I feel less alone. There are many people who think like this.", "I read primary sources now before forming an opinion.", "It gave me a calm way to answer friends who mock our traditions.", "I wake up early and give an hour every day to reading.", "I stopped wasting energy on arguments that change nothing."],
  purpose: ["To do something real on the ground, not only read and share.", "To meet people in my city who care about the same things.", "To contribute my professional skills where they are needed.", "To learn from senior members and grow as a person.", "To help build a network that supports people in difficult times.", "To serve, without expecting a position in return.", "To make sure young people in my area have good guidance."],
  skills: ["Web development and basic video editing.", "Accounting, GST and taxation help for small groups.", "Teaching and public speaking in Hindi and English.", "I own a small printing press and can print material at cost.", "Legal drafting and court procedure.", "Medical camps: I am a doctor and know other doctors nearby.", "Graphic design, Canva and Photoshop.", "Event organising and managing volunteers.", "Photography and short documentary filming.", "Contacts in local administration and the police.", "I can host meetings at my home or shop.", "Translation between Hindi, English and Bengali.", "Writing research notes and fact-checking.", "Driving and a vehicle for local travel.", "Data entry, spreadsheets and record keeping.", "Farming knowledge and contacts in nearby villages."],
  groups: ["Local temple committee", "Neighbourhood satsang group", "Our village bhajan mandali", "College study circle", "A seva trust that runs a library", "Gau seva samiti in my town"],
  since: ["Since 2021", "About two years", "Since the Telegram channel started", "Six months", "Since 2019", "A few weeks", "Since my college days", "One year"],
  isht: ["Shri Ram", "Shri Krishna", "Mahadev", "Hanuman ji", "Maa Durga", "Ganesh ji", "Maa Kali", "Bhagwan Vishnu", "Shri Venkateswara", "Jagannath ji"],
  religion: [["Hindu", 88], ["Sanatan Dharma", 7], ["Jain", 2], ["Sikh", 2], ["Buddhist", 1]],
  generic: ["Happy to help wherever I'm needed.", "Weekends work best for me.", "I heard about this through a friend.", "Nothing more for now. Thank you.", "Looking forward to it.", "Please keep me posted on Telegram.", "I can bring two friends along.", "Mornings are easier for me."],
  improve: ["Share the agenda a few days earlier.", "More time for questions at the end.", "A shorter form on mobile.", "Hold sessions in Hindi as well.", "Clearer directions to the venue."],
  liked: ["The talks were calm and well prepared.", "Meeting people from my own city.", "Everything started on time.", "The reading list was excellent.", "Simple, clear and respectful."]
};
const BLOOD = { "A+": 21, "A−": 1, "B+": 32, "B−": 1, "AB+": 7, "AB−": 0.4, "O+": 29, "O−": 1, "I don't know": 8 };

/** A plausible respondent, used to answer every question consistently. */
function persona(random, index, used = new Set()) {
  const gender = random.weighted([["male", 52], ["female", 45], ["other", 3]]);
  const state = random.weighted(STATES);
  let first = "";
  for (let attempt = 0; attempt < 8 && (!first || used.has(first)); attempt++) first = gender === "female" ? random.pick(FEMALE) : random.pick(MALE);
  used.add(first);
  const last = random.pick(SURNAMES[REGION[state] ?? "north"]);
  const known = (CITIES[state] ?? []).filter(name => districtsFor(state).includes(name));
  const district = state === "Outside India" ? random.pick(["London", "Dubai", "Singapore", "Toronto"]) : known.length && random.chance(0.85) ? random.pick(known) : random.pick(districtsFor(state));
  const age = Math.min(64, Math.max(18, Math.round(random.weighted([[21, 3], [25, 5], [29, 5], [34, 4], [40, 3], [47, 2], [55, 1]]) + random.between(-3, 3))));
  const profession = age <= 22 && random.chance(0.8) ? random.pick(STUDENTS) : random.pick(PROFESSIONS);
  const serial = String(index + 1).padStart(2, "0");
  return { gender, state, district, first, last, name: `${first} ${last}`, age, profession, serial,
    email: `${first}.${last}${random.between(1, 99)}`.toLowerCase() + "@example.com",
    // 98765 numbers are the conventional Indian example numbers; 020 7946 0xxx is reserved for drama in the UK.
    phone: state === "Outside India" ? `+44 20 7946 0${String(100 + index).slice(-3)}` : `+91 98765 ${String(10000 + index * 37).slice(-5)}`,
    altPhone: state === "Outside India" ? "" : `+91 98765 ${String(60000 + index * 41).slice(-5)}`,
    telegram: String(random.between(1000000000, 7999999999)) };
}

function choiceAnswer(field, random, weights) {
  const options = field.options ?? [];
  if (!options.length) return undefined;
  const weightOf = option => weights.get(option.id) ?? 1;
  if (field.type === "multi") {
    const min = Math.max(1, field.validation?.min ?? 1), max = Math.min(options.length, field.validation?.max ?? 3);
    const count = Math.max(min, Math.min(max, random.between(1, 3))), picked = new Set();
    while (picked.size < count) picked.add(random.weighted(options.map(option => [option.id, weightOf(option)])));
    return [...picked];
  }
  if (field.allowOther && random.chance(0.06)) return `${OTHER_PREFIX}${random.pick(["Depends on the week", "Prefer not to say", "Only during festivals", "Weekends only"])}`;
  return random.weighted(options.map(option => [option.id, weightOf(option)]));
}

/** Answers for one sample respondent, following the form's own questions and rules. */
function answersFor(form, person, random, skew, now) {
  const answers = {}, fields = allFields(form.schema);
  const label = field => `${field.label} ${field.help ?? ""}`.toLowerCase();
  const stateField = fields.find(field => field.type === "state");
  for (const field of fields) {
    if (field.type === "statement") continue;
    if (!field.required && !random.chance(field.type === "long" ? 0.72 : 0.82)) continue;
    const text = label(field);
    let value;
    switch (field.type) {
      case "short":
        value = field.role === "name" ? person.name : field.role === "profession" ? person.profession : field.role === "telegram" ? `@${person.first}_${person.last}`.toLowerCase()
          : /birth/.test(text) ? (random.chance(0.6) ? person.district : random.pick(CITIES[person.state] ?? [person.district]))
          : /locality|landmark|town|area/.test(text) ? random.pick(LOCALITIES) : /relig/.test(text) ? random.weighted(TEXT.religion)
          : /isht|god|devta|devi/.test(text) ? random.pick(TEXT.isht) : /which groups/.test(text) ? random.pick(TEXT.groups)
          : /since when|how long/.test(text) ? random.pick(TEXT.since) : /city|district/.test(text) ? person.district : random.pick(TEXT.generic);
        break;
      case "long":
        value = /address/.test(text) ? `${random.between(2, 240)}, ${random.pick(LOCALITIES)}, ${person.district}` : /dharma/.test(text) ? random.pick(TEXT.dharma)
          : /problem|challenge|face/.test(text) ? random.pick(TEXT.problems) : /influence|changed|impact/.test(text) ? random.pick(TEXT.influence)
          : /purpose|why/.test(text) ? random.pick(TEXT.purpose) : /skill|contribute|resource|help/.test(text) ? random.pick(TEXT.skills)
          : /improve|better/.test(text) ? random.pick(TEXT.improve) : /worked|liked|well/.test(text) ? random.pick(TEXT.liked) : random.pick(TEXT.generic);
        break;
      case "email": value = person.email; break;
      case "phone": value = field.role === "phone" || /whatsapp|active|primary/.test(text) ? person.phone : person.altPhone || undefined; break;
      case "number": {
        const min = field.validation?.min ?? 0, max = field.validation?.max ?? 100;
        value = /age/.test(text) ? Math.min(max, Math.max(min, person.age)) : random.between(min, Math.min(max, min + 50));
        break;
      }
      case "url": value = `https://example.com/${person.first.toLowerCase()}`; break;
      case "date": value = new Date(now + random.between(-40, 40) * DAY).toISOString().slice(0, 10); break;
      case "time": value = `${String(random.between(8, 20)).padStart(2, "0")}:${random.pick(["00", "15", "30", "45"])}`; break;
      case "single": case "dropdown": case "multi":
        if (/gender/.test(text) && field.options?.some(option => option.id === person.gender)) value = person.gender;
        else if (/gender/.test(text) && person.gender === "other" && field.allowOther) value = `${OTHER_PREFIX}Prefer not to say`;
        else if (/married/.test(text) && field.options?.some(option => option.id === "yes")) value = person.age >= 30 ? (random.chance(0.8) ? "yes" : "no") : person.age >= 26 ? (random.chance(0.45) ? "yes" : "no") : random.chance(0.1) ? "yes" : "no";
        else if (/blood/.test(text)) value = random.weighted((field.options ?? []).map(option => [option.id, BLOOD[option.label] ?? 1]));
        else value = choiceAnswer(field, random, skew(field));
        break;
      case "yesno": value = /same/.test(text) ? (random.chance(0.78) ? "yes" : "no") : random.chance(/in touch|groups/.test(text) ? 0.46 : 0.64) ? "yes" : "no"; break;
      case "scale": { const min = field.scale?.min ?? 1, max = field.scale?.max ?? 5; value = Math.min(max, Math.max(min, Math.round(min + (max - min) * (0.55 + 0.45 * random.next()) - random.between(0, 1)))); break; }
      case "rating": { const max = field.scale?.max ?? 5; value = Math.max(1, Math.min(max, max - random.weighted([[0, 5], [1, 4], [2, 2], [3, 1]]))); break; }
      case "state": value = person.state; break;
      case "district": value = person.district; break;
      case "telegram": value = person.telegram; break;
      case "social": value = random.chance(0.6) ? [{ platform: random.pick(["Instagram", "X", "LinkedIn", "Arattai"]), handle: `${person.first}_${person.last}${person.serial}`.toLowerCase() }] : undefined; break;
      case "consent": value = true; break;
      default: value = undefined;
    }
    if (value !== undefined && value !== "") answers[field.id] = value;
  }
  // Long permanent addresses only matter when the current one differs.
  for (const field of fields) if (field.type === "long" && /permanent/.test(label(field)) && answers[field.id]) answers[field.id] = `Village ${random.pick(["Rampur", "Sonpur", "Madhavpur", "Shivgarh", "Bhawanipur"])}, ${random.pick(districtsFor(person.state).length ? districtsFor(person.state) : [person.district])}`;
  // Keep only what the form itself would accept, dropping hidden or invalid answers.
  let result = validateAnswers(form.schema, answers);
  if (!result.ok) { for (const id of Object.keys(result.errors)) delete answers[id]; result = validateAnswers(form.schema, answers); }
  if (stateField && !result.clean[stateField.id] && answers[stateField.id]) result.clean[stateField.id] = answers[stateField.id];
  return result.clean;
}

/** When each sample response arrived: busier recently, mostly evenings India time. */
function arrivalTimes(random, count, now) {
  const times = [];
  for (let index = 0; index < count; index++) {
    const daysAgo = Math.floor(27 * Math.pow(random.next(), 1.2));
    const hour = random.weighted([[7, 1], [9, 2], [11, 2], [13, 3], [15, 2], [17, 2], [19, 4], [20, 5], [21, 6], [22, 4], [23, 2]]);
    const midnightIST = Math.floor((now + 5.5 * 3600000) / DAY) * DAY - 5.5 * 3600000;
    let time = midnightIST - daysAgo * DAY + hour * 3600000 + random.between(0, 59) * 60000 + random.between(0, 59) * 1000;
    if (time >= now) time = now - random.between(4, 240) * 60000;
    times.push(time);
  }
  return times.sort((a, b) => a - b);
}

export const SAMPLE_LINKS = [
  { code: "sample-whatsapp", label: "WhatsApp groups", share: 0.34, conversion: 0.31 },
  { code: "sample-telegram", label: "Telegram channel post", share: 0.27, conversion: 0.42 },
  { code: "sample-poster", label: "Meetup poster QR code", share: 0.09, conversion: 0.24 }
];

/** Build an isolated, populated copy of one form. Pure apart from `now`. */
export function buildSampleStore(form, { count = 42, now = Date.now() } = {}) {
  const random = generator(form.id), database = new DatabaseSync(":memory:");
  const store = new FormsStore(database, { now: () => new Date(now), seed: false });
  const created = Math.min(Date.parse(form.createdAt) || now, now - 40 * DAY);
  database.prepare("INSERT INTO forms VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(form.id, form.slug, form.title, form.description ?? "", form.status, JSON.stringify(form.schema), JSON.stringify(form.settings), JSON.stringify(form.theme), created, Date.parse(form.updatedAt) || now, "sample");
  const stored = store.form(form.id);
  for (const link of SAMPLE_LINKS) database.prepare("INSERT INTO form_links VALUES (?,?,?,?,1,?,?)").run(link.code, form.id, link.label, "{}", created, "sample");
  // Each choice question leans towards a few answers, so its chart has a shape.
  const skews = new Map();
  const skew = field => { if (!skews.has(field.id)) { const weights = new Map(); (field.options ?? []).forEach((option, index) => weights.set(option.id, (index === 0 ? 2.2 : 1) * (0.25 + random.next() * 1.75))); skews.set(field.id, weights); } return skews.get(field.id); };
  const insert = database.prepare("INSERT INTO form_responses (id,form_id,receipt_hash,user_id,status,answers,state,link,device,duration_ms,tg_user_id,tg_username,note,reviewed_by,reviewed_at,created_at,updated_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const stateField = allFields(stored.schema).find(field => field.role === "state") ?? allFields(stored.schema).find(field => field.type === "state");
  const telegramField = allFields(stored.schema).find(field => field.type === "telegram");
  const notes = ["Called on WhatsApp, genuine.", "Knows two members in Pune.", "Duplicate of an older response.", "Spoke to them on Telegram.", "Strong skills, follow up for events.", ""];
  const usedNames = new Set();
  arrivalTimes(random, count, now).forEach((time, index) => {
    const person = persona(random, index, usedNames), answers = answersFor(stored, person, random, skew, now);
    const age = now - time, status = !stored.settings.requireApproval ? "approved" : age < 3 * DAY ? random.weighted([["pending", 8], ["approved", 2], ["rejected", 0.6]]) : age < 10 * DAY ? random.weighted([["approved", 6], ["pending", 2.5], ["rejected", 1.2]]) : random.weighted([["approved", 7], ["rejected", 1.4]]);
    const reviewed = status !== "pending" ? Math.min(now - 60000, time + random.between(2, 40) * 3600000) : null;
    const id = `sample-${createHash("sha256").update(`${form.id}:${index}`).digest("hex").slice(0, 20)}`;
    const roll = random.next(); let link = null, cumulative = 0;
    for (const candidate of SAMPLE_LINKS) { cumulative += candidate.share; if (roll < cumulative) { link = candidate.code; break; } }
    const device = random.weighted([["mobile", 58], ["desktop", 22], ["telegram", 15], ["tablet", 5]]);
    const state = stateField ? (INDIA_STATES.includes(answers[stateField.id]) ? answers[stateField.id] : null) : null;
    insert.run(id, form.id, `sample-receipt-${id}`, null, status, JSON.stringify(answers), state, link, device, random.between(4, 16) * 60000 + random.between(0, 59000),
      telegramField && answers[telegramField.id] ? answers[telegramField.id] : null, null, status === "pending" ? null : random.chance(0.35) ? random.pick(notes) || null : null,
      reviewed ? SAMPLE_REVIEWER : null, reviewed, time, reviewed ?? time, null);
  });
  // Opens and starts per day and link, so the funnel and link conversion have something to show.
  const daily = new Map();
  for (const row of database.prepare("SELECT created_at,link FROM form_responses").all()) { const key = `${store.day(row.created_at, stored.settings.timezone).day}|${row.link ?? ""}`; daily.set(key, (daily.get(key) ?? 0) + 1); }
  for (let cursor = now - 29 * DAY; cursor <= now; cursor += DAY) for (const link of [{ code: "", conversion: 0.38 }, ...SAMPLE_LINKS]) {
    const day = store.day(cursor, stored.settings.timezone).day, submitted = daily.get(`${day}|${link.code}`) ?? 0;
    const views = Math.round(submitted / link.conversion + random.between(0, 2)), starts = Math.min(views, submitted ? Math.round(submitted * 1.15 + (random.chance(0.35) ? 1 : 0)) : random.chance(0.1) ? 1 : 0);
    if (views) database.prepare("INSERT INTO form_events VALUES (?,?,?,?,?)").run(form.id, day, link.code, "view", views);
    if (starts) database.prepare("INSERT INTO form_events VALUES (?,?,?,?,?)").run(form.id, day, link.code, "start", starts);
  }
  return store;
}

/** One sample store per admin and form, kept for a few hours, never more than `limit` at once. */
export function createSampleForms({ now = () => Date.now(), limit = 60, lifetimeMs = 6 * 3600000 } = {}) {
  const stores = new Map();
  const keyOf = (email, form) => `${email}\n${form.id}\n${form.updatedAt}`;
  function storeFor(email, form) {
    const key = keyOf(email, form), time = now(), current = stores.get(key);
    if (current && time - current.created < lifetimeMs) { current.used = time; return current.store; }
    if (current) { current.store.database.close(); stores.delete(key); }
    while (stores.size >= limit) { const [oldest] = [...stores.entries()].sort((a, b) => a[1].used - b[1].used); oldest[1].store.database.close(); stores.delete(oldest[0]); }
    const store = buildSampleStore(form, { now: time });
    stores.set(key, { store, created: time, used: time });
    return store;
  }
  function reset(email) { for (const [key, entry] of stores) if (key.startsWith(`${email}\n`)) { entry.store.database.close(); stores.delete(key); } }
  const close = () => { for (const entry of stores.values()) entry.store.database.close(); stores.clear(); };
  return { storeFor, reset, close, get size() { return stores.size; } };
}
