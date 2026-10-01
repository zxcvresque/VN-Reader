import type { SignupCapacity as Capacity } from "../lib/admin";

export default function SignupCapacity({capacity,error,onRetry,compact=false}:{capacity:Capacity|null;error?:string;onRetry:()=>void;compact?:boolean}) {
  const reset=capacity?new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"}).format(new Date(capacity.resetsAt)):null;
  return <div className={`signup-capacity${compact?" is-compact":""}`} role="status">
    {error?<><span>{error}</span><button type="button" onClick={onRetry}>Check again</button></>:!capacity?<span>Checking today’s signup allowance…</span>:!capacity.configured?<span>Email verification is being connected. You can read as a guest.</span>:<>
      <span className={`signup-capacity-pill ${capacity.remaining===0?"is-full":""}`}><span aria-hidden="true" className="signup-capacity-dot"/>{capacity.remaining.toLocaleString()} email {capacity.remaining===1?"slot":"slots"} left today</span>
      {(!compact||capacity.remaining===0)&&<span>{capacity.remaining===0?`Email verification is full for today. Continue as a guest, or try again after ${reset}.`:`Each new account needs one verification email. Resends and resets also use slots. Resets ${reset}.`}</span>}
    </>}
  </div>;
}
