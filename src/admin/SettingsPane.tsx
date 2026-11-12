import { useEffect, useState } from "react";
import { call, type AdminSettings } from "../forms/api";
import { Card } from "./charts";
import { Confirm, Failure, Loading, useAction, useLoad } from "./ui";

export default function SettingsPane() {
  const run = useAction();
  const { data, setData, error, reload } = useLoad(() => call<AdminSettings>("/admin/settings"), []);
  const [token, setToken] = useState(""), [chat, setChat] = useState(""), [thread, setThread] = useState(""), [busy, setBusy] = useState(""), [clearing, setClearing] = useState(false);
  useEffect(() => { if (data) { setChat(data.telegram.backupChat); setThread(data.telegram.backupThread); } }, [data?.telegram.backupChat, data?.telegram.backupThread]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Failure message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { telegram, r2 } = data;
  const save = async (body: Record<string, unknown>, done: string, key: string) => { setBusy(key); const next = await run(() => call<AdminSettings>("/admin/settings", { method: "PUT", body }), done); setBusy(""); if (next) { setData(next); setToken(""); } };
  const post = async (path: string, done: string, key: string) => { setBusy(key); await run(() => call(path, { body: {} }), done); setBusy(""); };
  const ready = telegram.tokenSource !== "none" && !!telegram.backupChat;
  return <>
    <header className="va-head"><div><h1>Backups and Telegram</h1><p>Where copies of form responses go, and how the bot reaches people.</p></div></header>
    <div className="va-grid cols-2">
      <Card title="Telegram bot" note={telegram.tokenSource === "console" ? `Connected${telegram.botUsername ? ` as @${telegram.botUsername}` : ""}, token ending ${telegram.tokenHint}` : telegram.tokenSource === "server" ? `Using the server's bot, token ending ${telegram.tokenHint}` : "Not connected yet"}>
        <div className="va-stack">
          <label className="vg-label">{telegram.tokenSource === "console" ? "Replace the bot token" : "Bot token from @BotFather"}<input className="vg-input" type="password" autoComplete="off" placeholder="123456789:AA…" value={token} onChange={event => setToken(event.target.value)} /><span className="va-note" style={{ fontWeight: 400 }}>Stored on your server and never shown again. Telegram is asked to confirm the token before it's saved.</span></label>
          <div className="va-row"><button type="button" className="vg-btn is-primary" disabled={!token.trim() || busy === "token"} onClick={() => void save({ botToken: token }, "Bot connected.", "token")}>{busy === "token" ? "Checking with Telegram…" : "Save token"}</button>{telegram.tokenSource === "console" && <button type="button" className="vg-btn is-quiet is-danger" onClick={() => setClearing(true)}>Remove token</button>}</div>
        </div>
      </Card>
      <Card title="Backup channel" note="A private channel or group where every response is posted as a file.">
        <div className="va-stack">
          <div className="va-fieldgrid"><label className="vg-label">Channel or group ID<input className="vg-input" placeholder="-1001234567890 or @channel" value={chat} onChange={event => setChat(event.target.value)} /></label><label className="vg-label">Topic ID (forum groups only)<input className="vg-input" inputMode="numeric" placeholder="Optional" value={thread} onChange={event => setThread(event.target.value)} /></label></div>
          <p className="va-note">Add the bot to the channel as an admin with permission to post. To find a channel's numeric ID, forward one of its posts to @RawDataBot.</p>
          <div className="va-row"><button type="button" className="vg-btn is-primary" disabled={busy === "chat" || (chat === telegram.backupChat && thread === telegram.backupThread)} onClick={() => void save({ backupChat: chat, backupThread: thread }, "Backup channel saved.", "chat")}>{busy === "chat" ? "Saving…" : "Save channel"}</button><button type="button" className="vg-btn" disabled={!ready || busy === "test"} onClick={() => void post("/admin/settings/telegram-test", "Test message sent. Check the channel.", "test")}>{busy === "test" ? "Sending…" : "Send a test message"}</button></div>
        </div>
      </Card>
      <Card title="What the bot sends">
        <div className="va-stack">
          <label className="vg-switch"><input type="checkbox" checked={telegram.notifyOnSubmit} onChange={event => void save({ notifyOnSubmit: event.target.checked }, "Saved.", "flags")} /><span>Post every new response to the backup channel<small>A JSON file with the full answers, plus a note when a response is approved or rejected. Each form can opt out in its settings.</small></span></label>
          <label className="vg-switch"><input type="checkbox" checked={telegram.dmOnDecision} onChange={event => void save({ dmOnDecision: event.target.checked }, "Saved.", "flags")} /><span>Message people when their response is reviewed<small>Reaches people who filled the form inside the bot's web app or tapped “Get updates on Telegram”. Approved people get their link as a button. In the bot, /status shows each person only their own responses.</small></span></label>
          <label className="vg-switch"><input type="checkbox" disabled={!data.email?.available} checked={!!data.email?.onDecision && !!data.email?.available} onChange={event => void save({ emailOnDecision: event.target.checked }, "Saved.", "flags")} /><span>Email people who asked for an email update<small>{data.email?.available ? "Sent through the site's existing email service and counted in the daily email allowance." : "Email delivery isn't set up on this server, so this stays off."}</small></span></label>
        </div>
      </Card>
      <Card title="Website inside the bot" note="Adds an “Open Vidurneeti” button to the bot's chat menu.">
        <div className="va-stack"><p className="va-note">The button opens <span className="va-code">{telegram.webAppUrl}</span> as a Telegram web app. Forms filled there are linked to the person's Telegram account, which is what lets the bot message them later.</p>
          <div><button type="button" className="vg-btn" disabled={telegram.tokenSource === "none" || busy === "menu"} onClick={() => void post("/admin/settings/telegram-menu", "Menu button set. Open the bot in Telegram to see it.", "menu")}>{busy === "menu" ? "Setting…" : "Set the bot's menu button"}</button></div></div>
      </Card>
      <Card title="R2 object storage" note={r2.enabled ? `Mirroring to the private bucket ${r2.bucket}` : "Not mirroring yet"}>
        {r2.enabled ? <p className="va-note">Every response is written to <span className="va-code">{r2.bucket}/forms/&lt;form&gt;/responses/</span> as its own JSON file and updated when its status changes. {r2.waiting ? `${r2.waiting} waiting to upload; they retry every five minutes.` : "Everything is uploaded."}</p>
          : <><p className="vg-alert" data-tone="warn">{r2.reason}</p><p className="va-note" style={{ marginTop: 10 }}>Form answers include addresses and phone numbers, so they are only ever sent to a bucket without public access, never the media bucket. Create a private bucket, set <span className="va-code">R2_FORMS_BUCKET</span> in the server's .env, and restart the accounts service. Responses already collected upload automatically.</p></>}
      </Card>
    </div>
    {clearing && <Confirm title="Remove the bot token?" body="Backups to Telegram and messages to respondents stop until a token is added again." action="Remove token" danger onClose={() => setClearing(false)} onConfirm={() => save({ botToken: "" }, "Token removed.", "token")} />}
  </>;
}
