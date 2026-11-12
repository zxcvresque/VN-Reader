// The Vidurneeti Ground Work form, rebuilt from the original SurveyHeart form.
// Seeded once; after that the admin console owns it.
const option = (id, label) => ({ id, label });
const yesNo = [option("yes", "Yes"), option("no", "No")];

export const GROUNDWORK_FORM = {
  slug: "groundwork",
  title: "Vidurneeti Ground Work",
  description: "This form collects your details and keeps them safely backed up for genuine use in future ground work.",
  status: "live",
  schema: { pages: [
    { id: "about", title: "About you", fields: [
      { id: "gw_name", type: "short", label: "Full name", required: true, role: "name", validation: { minLength: 2, maxLength: 120 } },
      { id: "gw_age", type: "number", label: "Your age", required: true, validation: { min: 13, max: 110 } },
      { id: "gw_gender", type: "single", label: "Gender", required: true, allowOther: true, options: [option("male", "Male"), option("female", "Female")] },
      { id: "gw_married", type: "single", label: "Married", required: true, options: yesNo },
      { id: "gw_birthplace", type: "short", label: "Your place of birth" },
      { id: "gw_address", type: "long", label: "Place you live currently", help: "Full address.", required: true },
      { id: "gw_state", type: "state", label: "State or union territory you live in", required: true, role: "state" },
      { id: "gw_district", type: "short", label: "District or city", required: true, role: "district" },
      { id: "gw_same_address", type: "yesno", label: "Is your permanent address the same as your current address?", required: true },
      { id: "gw_permanent", type: "long", label: "Permanent address", help: "Full address.", required: true, showIf: { mode: "all", rules: [{ field: "gw_same_address", op: "eq", value: "no" }] } },
      { id: "gw_profession", type: "short", label: "Your profession", required: true, role: "profession" },
      { id: "gw_blood", type: "dropdown", label: "Your blood group", options: ["A+", "A−", "B+", "B−", "AB+", "AB−", "O+", "O−", "I don't know"].map((label, index) => option(`bg${index}`, label)) },
      { id: "gw_religion", type: "short", label: "Religion you follow" },
      { id: "gw_isht", type: "short", label: "Your Isht Devta/Devi, or the God you believe in" }
    ] },
    { id: "contact", title: "How to reach you", fields: [
      { id: "gw_whatsapp", type: "phone", label: "Active contact / WhatsApp number", required: true, role: "phone" },
      { id: "gw_alt_phone", type: "phone", label: "Alternative contact number" },
      { id: "gw_email", type: "email", label: "Email ID", required: true, role: "email" },
      { id: "gw_telegram", type: "short", label: "Your genuine Telegram ID (username)", help: "We use this to contact you. Example: @yourname", required: true, role: "telegram", validation: { pattern: "^@?[A-Za-z][A-Za-z0-9_]{3,31}$", patternMessage: "Enter your Telegram username, like @yourname." } },
      { id: "gw_social", type: "short", label: "Active social media ID", help: "Any other social media on which you can be reached most reliably." }
    ] },
    { id: "dharma", title: "Dharma and Vidur Neeti", fields: [
      { id: "gw_dharma", type: "long", label: "Things you can do for your Dharma, today or in future, if you get the position and power", required: true },
      { id: "gw_geeta", type: "single", label: "Do you read the Bhagavad Geeta?", allowOther: true, options: [option("daily", "Daily"), option("weekly", "Weekly"), option("monthly", "Monthly"), option("yearly", "Yearly"), option("never", "I do not read")] },
      { id: "gw_problems", type: "long", label: "Problems you face daily in your life", help: "Social, economic and political." },
      { id: "gw_groups", type: "yesno", label: "Are you in touch with the local RSS cadre or any other Hindu groups that can support you in need?" },
      { id: "gw_groups_which", type: "short", label: "Which groups are you in touch with?", showIf: { mode: "all", rules: [{ field: "gw_groups", op: "eq", value: "yes" }] } },
      { id: "gw_since", type: "short", label: "Since when have you been connected with Vidur Neeti?" },
      { id: "gw_influence", type: "long", label: "How has Vidur Neeti influenced or changed your life, thinking, or approach?", required: true },
      { id: "gw_purpose", type: "long", label: "What is your purpose in joining Vidur Neeti ground work?" }
    ] },
    { id: "contribute", title: "What you can contribute", fields: [
      { id: "gw_willing", type: "single", label: "When required, are you willing to take calls, support and connect on ground with fellow members, to the extent reasonably possible for you?", allowOther: true, options: [option("yes", "Yes"), option("no", "No"), option("depends", "Depends on circumstances")] },
      { id: "gw_skills", type: "long", label: "What skills, resources, professional connections, or other capabilities can you contribute to Vidurneeti ground work?", required: true }
    ] }
  ] },
  settings: {
    access: "public", oneResponse: "device", requireApproval: true, showProgress: true,
    reward: { enabled: true, label: "Groundwork group link", url: "https://t.me/+EcstnRyYKytlOWE9" },
    confirmation: { title: "Thank you. Your response is in.", message: "An admin reviews every response. Once yours is approved, the Groundwork group link appears on this page." },
    approvedMessage: "You're approved. Welcome to Vidurneeti ground work.",
    rejectedMessage: "This response wasn't approved. If you think that's a mistake, contact the Vidurneeti admins on Telegram.",
    notifyTelegram: true
  },
  theme: { accent: "#f2a23a", font: "aspekta", surface: "glass", mode: "auto", backdrop: "aurora", radius: 22, layout: "classic", submitLabel: "Submit response" }
};
