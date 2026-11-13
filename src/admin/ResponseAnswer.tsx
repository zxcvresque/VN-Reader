import { CopyIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { displayAnswer } from "../../server/formLogic.mjs";
import type { AnswerValue, FormField, SocialAccount } from "../forms/api";
import { useToast } from "./ui";

function profileLink(field: FormField, value: string): string | undefined {
  const text = value.trim();
  const telegram = field.role === "telegram" || (field.type === "short" && /\btelegram (?:account|id|username)\b/i.test(field.label));
  if (telegram && /^@?[a-z][a-z0-9_]{3,31}$/i.test(text)) {
    return `https://t.me/${text.replace(/^@/, "")}`;
  }
  if (field.type === "phone" && /\bwhatsapp\b/i.test(field.label) && /^\+[\d ().-]+$/.test(text)) {
    const number = text.replace(/\D/g, "");
    if (/^[1-9]\d{7,14}$/.test(number)) return `https://wa.me/${number}`;
  }

  const explicit = /^https?:\/\//i.test(text);
  const bareDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]|$)/i.test(text);
  const expectsLink = field.type === "url" || telegram || /\bsocial media\b/i.test(field.label);
  const socialDomain = /^(?:www\.)?(?:t\.me|telegram\.me|wa\.me|instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|threads\.(?:net|com)|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|bsky\.app)(?:[/?#]|$)/i.test(text);
  if (/\s|\\/.test(text) || !(explicit || (bareDomain && (expectsLink || socialDomain)))) return;

  try {
    const url = new URL(explicit ? text : `https://${text}`);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch { /* Keep invalid or ambiguous links copyable as text. */ }
}

/** `links` off leaves answers copyable but never links out, as for sample data that only looks like real contacts. */
export default function ResponseAnswer({ field, answer, links = true }: { field: FormField; answer: AnswerValue | undefined; links?: boolean }) {
  const toast = useToast();
  const value = displayAnswer(field, answer);
  const href = links && typeof answer === "string" ? profileLink(field, value) : undefined;
  const profiles = links && field.type === "social" && Array.isArray(answer)
    ? answer.filter((item): item is SocialAccount => typeof item === "object" && item !== null && typeof item.platform === "string" && typeof item.handle === "string")
    : [];
  const domains: Record<string, string> = {
    instagram: "instagram.com", facebook: "facebook.com", x: "x.com", twitter: "x.com",
    bluesky: "bsky.app/profile", reddit: "reddit.com/user", threads: "threads.net/@",
    linkedin: "linkedin.com/in", youtube: "youtube.com/@", tiktok: "tiktok.com/@"
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast("Answer copied.");
    } catch {
      toast("Couldn't copy the answer. Select the text to copy it manually.", "bad");
    }
  };

  return <div className="va-answer">
    <dt>{field.label}</dt>
    {!value ? <dd className="is-empty">Not answered</dd> : <dd className="va-answer-actions">
      <button type="button" className="va-answer-copy" onClick={copy} title="Copy answer">
        <span className="vg-sr">Copy {field.label}: </span><span>{value}</span><CopyIcon aria-hidden="true" />
      </button>
      {profiles.map((profile, index) => {
        const domain = domains[profile.platform.toLowerCase()];
        const handle = profile.handle.trim().replace(/^@/, "");
        const target = profileLink(field, profile.handle) ?? (domain && /^[a-z0-9_.-]+$/i.test(handle) ? `https://${domain}${domain.endsWith("@") ? "" : "/"}${handle}` : undefined);
        return target ? <a key={index} className="va-answer-link" href={target} target="_blank" rel="noopener noreferrer" aria-label={`Open ${profile.platform} profile in a new tab`} title={`Open ${profile.platform}`}><ExternalLinkIcon aria-hidden="true" /></a> : null;
      })}
      {href && <a className="va-answer-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${field.label} in a new tab`} title="Open link in a new tab"><ExternalLinkIcon aria-hidden="true" /></a>}
    </dd>}
  </div>;
}
