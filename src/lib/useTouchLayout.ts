import {useEffect,useState} from "react";
export function useTouchLayout() {
  const [touch,setTouch]=useState(()=>typeof window!=="undefined"&&typeof window.matchMedia==="function"&&window.matchMedia("(pointer: coarse), (max-width: 767px)").matches);
  useEffect(()=>{if(typeof window.matchMedia!=="function")return;const media=window.matchMedia("(pointer: coarse), (max-width: 767px)");const update=()=>setTouch(media.matches);update();media.addEventListener?.("change",update);return()=>media.removeEventListener?.("change",update);},[]);
  return touch;
}
