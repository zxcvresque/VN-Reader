import {useEffect,useRef,useState} from "react";
import {ReaderIcon,BookmarkIcon,BarChartIcon,Share2Icon,MagnifyingGlassIcon,EnterFullScreenIcon,ExitFullScreenIcon,MixerHorizontalIcon,QuestionMarkCircledIcon,PersonIcon,HamburgerMenuIcon,Cross2Icon,EyeOpenIcon,EyeClosedIcon} from "@radix-ui/react-icons";
import type {ViewName} from "./CommandPalette";
import BrandLogo from "./BrandLogo";
import {useTouchLayout} from "../lib/useTouchLayout";
interface TopBarProps {
  channelTitle:string;channelMeta:string;anchorLabel:string;progressPercent:number;view:ViewName;
  onSetView:(view:ViewName)=>void;onOpenPalette:()=>void;onOpenSettings?:()=>void;onOpenGuide?:()=>void;onOpenAccount?:()=>void;onOpenLibrary?:()=>void;
  navPosition?:"top"|"bottom"|"left"|"right";guideMenuOpen?:boolean;accountLabel?:string;paletteOpen?:boolean;settingsOpen?:boolean;guideOpen?:boolean;accountOpen?:boolean;onToggleFocus?:()=>void;focusMode?:boolean;
}
const VIEWS:Array<{key:ViewName;label:string;icon:typeof ReaderIcon}>=[
  {key:"read",label:"Read",icon:ReaderIcon},{key:"threads",label:"Threads",icon:Share2Icon},{key:"bookmarks",label:"Bookmarks",icon:BookmarkIcon},{key:"progress",label:"Progress",icon:BarChartIcon}
];
export default function TopBar({channelTitle,anchorLabel,progressPercent,view,onSetView,onOpenPalette,onOpenSettings,onOpenGuide,onOpenAccount,onOpenLibrary,accountLabel,paletteOpen=false,settingsOpen=false,guideOpen=false,guideMenuOpen=false,accountOpen=false,onToggleFocus,focusMode=false,navPosition="top"}:TopBarProps) {
  const [autoHide,setAutoHide]=useState(()=>{try{return localStorage.getItem("vn-reader-nav-auto-hide")==="true";}catch{return false;}});
  const [revealed,setRevealed]=useState(false);
  const hideTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const pointerInside=useRef(false);
  const cancelHide=()=>{if(hideTimer.current!==null){clearTimeout(hideTimer.current);hideTimer.current=null;}};
  const reveal=()=>{cancelHide();setRevealed(true);};
  const scheduleHide=()=>{cancelHide();hideTimer.current=setTimeout(()=>{if(!pointerInside.current&&!shell.current?.querySelector(":focus-visible"))setRevealed(false);},350);};
  useEffect(()=>()=>cancelHide(),[]);
  const [menuOpen,setMenuOpen]=useState(false);const shell=useRef<HTMLElement>(null);const menuButton=useRef<HTMLButtonElement>(null);const touch=useTouchLayout();
  useEffect(()=>{setMenuOpen(false);},[view,focusMode]);
  useEffect(()=>{setMenuOpen(guideOpen);},[guideOpen]);
  useEffect(()=>{if(!menuOpen)return;const outside=(e:PointerEvent)=>{if(!shell.current?.contains(e.target as Node))setMenuOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){setMenuOpen(false);menuButton.current?.focus();}};document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);};},[menuOpen]);
  const shown=guideOpen?guideMenuOpen:menuOpen;
  useEffect(()=>{if(!autoHide||!touch||shown)return;const hide=()=>{if(!shell.current?.querySelector(":focus-visible"))setRevealed(false);};window.addEventListener("scroll",hide,{passive:true,capture:true});return()=>window.removeEventListener("scroll",hide,true);},[autoHide,touch,shown]);
  const run=(action?:()=>void)=>{setMenuOpen(false);action?.();};
  const revealEdge=focusMode||(touch&&(navPosition==="left"||navPosition==="right"))?"top":navPosition;
  const hidden=autoHide&&!revealed&&!shown&&!guideOpen;
  return <>{autoHide&&<button type="button" data-edge={revealEdge} className={`nav-reveal-edge ${hidden?"":"is-revealed"}`} tabIndex={hidden?0:-1} aria-label="Show navigation" aria-controls="reader-navigation-dock" aria-expanded={!hidden} onPointerEnter={()=>{if(!touch)reveal();}} onPointerLeave={()=>{if(!touch)scheduleHide();}} onFocus={()=>{if(!touch)reveal();}} onClick={()=>{reveal();requestAnimationFrame(()=>shell.current?.querySelector<HTMLButtonElement>(".top-bar-actions button")?.focus({preventScroll:true}));}}><span>{touch?<HamburgerMenuIcon aria-hidden="true"/>:null}</span></button>}
  <header id="reader-navigation-dock" ref={shell} onPointerEnter={()=>{pointerInside.current=true;if(!touch)reveal();}} onPointerLeave={()=>{pointerInside.current=false;if(!touch)scheduleHide();}} onFocusCapture={reveal} onBlurCapture={event=>{if(!shell.current?.contains(event.relatedTarget as Node))scheduleHide();}} className={`top-bar is-expanded minimal-nav ${shown?"is-mobile-open":""} ${hidden?"nav-auto-hidden":""}`}>

    <div className="top-bar-channel" aria-label="vn reader"><span className="top-bar-mark"><BrandLogo width={42}/></span></div>
    <div className={`top-bar-menu-panel ${shown?"is-open":""}`}>
    <nav id="reader-view-navigation" data-tour="navigation" className="view-switch" aria-label="Views">
      {VIEWS.map(({key,label,icon:Icon})=><button key={key} type="button" data-tour={`view-${key}`} aria-label={label} aria-current={view===key?"page":undefined} className={view===key?"active":""} onClick={()=>run(()=>onSetView(key))}><Icon aria-hidden/><span>{label}</span></button>)}
    </nav>
    {shown&&<div id="reader-utility-navigation" className="top-bar-utility-panel" aria-label="Reader menu">
      {onOpenLibrary&&<button type="button" onClick={()=>run(onOpenLibrary)}><BookmarkIcon aria-hidden/><span>My library</span></button>}
      {onOpenSettings&&<button type="button" data-tour="settings" aria-expanded={settingsOpen} onClick={()=>run(onOpenSettings)}><MixerHorizontalIcon aria-hidden/><span>Appearance & settings</span></button>}
      {onOpenGuide&&<button type="button" data-tour="help" aria-expanded={guideOpen} onClick={()=>run(onOpenGuide)}><QuestionMarkCircledIcon aria-hidden/><span>Help & tours</span></button>}
      {onOpenAccount&&<button type="button" data-tour="account-controls" aria-expanded={accountOpen} onClick={()=>run(onOpenAccount)}><PersonIcon aria-hidden/><span>{accountLabel??"Your account"}</span></button>}
      <p>Reading position: {anchorLabel} ({Math.round(Math.max(0,Math.min(100,progressPercent)))}%)</p>
    </div>}
    </div>
    <div className="top-bar-actions">
      <button type="button" className="nav-action" aria-label={autoHide?"Keep navigation visible":"Hide navigation while reading"} aria-pressed={autoHide} data-tooltip={autoHide?"Keep navigation visible":`Hide while reading · reveal at ${revealEdge} edge`} onClick={()=>{const next=!autoHide;cancelHide();setAutoHide(next);setRevealed(true);try{localStorage.setItem("vn-reader-nav-auto-hide",String(next));}catch{}}}>{autoHide?<EyeClosedIcon aria-hidden/>:<EyeOpenIcon aria-hidden/>}<span className="mobile-action-label">{autoHide?"Auto hide":"Pinned"}</span></button>
      <button type="button" data-tour="search" className="top-bar-search nav-action" aria-haspopup="dialog" aria-expanded={paletteOpen} onClick={()=>run(onOpenPalette)} aria-label="Search and commands" data-tooltip={touch?"Search":"Search · Ctrl / ⌘ K"}><MagnifyingGlassIcon aria-hidden/><span className="mobile-action-label">Search</span></button>
      {onToggleFocus&&<button type="button" data-tour="focus" className="nav-action top-bar-focus" aria-label={focusMode?"Exit focus mode":"Enter focus mode"} aria-pressed={focusMode} onClick={onToggleFocus} data-tooltip={focusMode?"Exit focus":"Focus mode"}>{focusMode?<ExitFullScreenIcon aria-hidden/>:<EnterFullScreenIcon aria-hidden/>}<span className="mobile-action-label">{focusMode?"Exit focus":"Focus"}</span></button>}
      <button ref={menuButton} type="button" className="nav-action top-bar-menu" data-tour="reader-menu" aria-label={shown?"Close reader menu":"Open reader menu"} aria-controls="reader-view-navigation reader-utility-navigation" aria-expanded={shown} onClick={event=>{setMenuOpen(v=>!v);if(!shown&&event.detail===0)requestAnimationFrame(()=>shell.current?.querySelector<HTMLButtonElement>(touch?".top-bar-menu-panel button":".top-bar-utility-panel button")?.focus({preventScroll:true}));}}>{shown?<Cross2Icon aria-hidden/>:<HamburgerMenuIcon aria-hidden/>}<span className="mobile-action-label">{shown?"Close":"Menu"}</span></button>
    </div>
  </header></>;
}
