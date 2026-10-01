import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { SignupCapacity } from "./admin";

export function useSignupCapacity() {
  const [capacity,setCapacity] = useState<SignupCapacity|null>(null);
  const [error,setError] = useState("");
  const [attempt,setAttempt] = useState(0);
  const refresh = useCallback(()=>setAttempt(n=>n+1),[]);
  useEffect(()=>{
    let active=true;
    const load=()=>void api<SignupCapacity>("/signup-capacity").then(data=>{if(active){setCapacity(data);setError("");}}).catch(()=>{if(active){setCapacity(null);setError("The daily allowance couldn’t be checked.");}});
    load();const timer=window.setInterval(load,60000);
    const visible=()=>{if(document.visibilityState==="visible")load();};
    document.addEventListener("visibilitychange",visible);
    return()=>{active=false;window.clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[attempt]);
  return {capacity,error,refresh};
}
